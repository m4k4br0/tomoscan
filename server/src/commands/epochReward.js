const BigNumber = require('bignumber.js')
const Web3Util = require('../helpers/web3')
const db = require('../models')
const config = require('config')
const TomoValidatorABI = require('../contracts/abi/TomoValidator')
const BlockSignerABI = require('../contracts/abi/BlockSigner')
const contractAddress = require('../contracts/contractAddress')

const epochReward = async (epoch) => {
    console.log('Start process', new Date())
    let startBlock = (epoch - 1) * config.get('BLOCK_PER_EPOCH') + 1
    let endBlock = (epoch) * config.get('BLOCK_PER_EPOCH')
    const web3 = await Web3Util.getWeb3()

    let maxBlockNum = await web3.eth.getBlockNumber()
    if (maxBlockNum - config.get('BLOCK_PER_EPOCH') < endBlock) {
        console.log('Epoch is waiting for calculate')
        return
    }
    console.log('Re-calculate reward from block %s to block %s', startBlock, endBlock)

    // Delete old reward
    console.log('Remove old reward')
    await db.Reward.remove({ epoch: epoch })

    let totalReward = new BigNumber(config.get('REWARD'))
    let validatorRewardPercent = new BigNumber(config.get('MASTER_NODE_REWARD_PERCENT'))
    let foundationRewardPercent = new BigNumber(config.get('FOUNDATION_REWARD_PERCENT'))
    let voterRewardPercent = new BigNumber(config.get('VOTER_REWARD_PERCENT'))

    let validatorContract = await new web3.eth.Contract(TomoValidatorABI, contractAddress.TomoValidator)
    let bs = await new web3.eth.Contract(BlockSignerABI, contractAddress.BlockSigner)

    // verify block was on chain
    let epochSignNumber = await db.BlockSigner.countDocuments({ blockNumber: { $gte: startBlock, $lte: endBlock } })
    if (epochSignNumber < config.get('BLOCK_PER_EPOCH')) {
        console.log('Begin get block signer')
        for (let i = startBlock; i <= endBlock; i++) {
            let blockHash = (await web3.eth.getBlock(i)).hash
            let ss = await bs.methods.getSigners(blockHash).call()
            await db.BlockSigner.updateOne({
                blockHash: blockHash,
                blockNumber: i
            }, {
                $set: {
                    blockHash: blockHash,
                    blockNumber: i,
                    signers: ss.map(it => (it || '').toLowerCase())
                }
            }, {
                upsert: true
            }).then(function () {
                if (i % 50 === 0) {
                    console.log('Update block signer block', i, new Date())
                }
            })
        }
    }

    // Get list event in range start - end block
    await db.VoteHistory.remove({ blockNumber: { $gte: startBlock, $lte: endBlock } })
    const tomoValidator = await new web3.eth.Contract(TomoValidatorABI, contractAddress.TomoValidator)
    try {
        let pastEvent = await tomoValidator.getPastEvents('allEvents', {
            filter: {},
            fromBlock: startBlock,
            toBlock: endBlock
        }, function (error, events) {
            if (error) {
                console.error(error)
            }
            let listUser = []

            for (let i = 0; i < events.length; i++) {
                let event = events[i]
                let voter = String(event.returnValues._voter || '').toLowerCase()
                let owner = String(event.returnValues._owner || '').toLowerCase()
                let candidate = String(event.returnValues._candidate || '').toLowerCase()
                let cap = new BigNumber(event.returnValues._cap || 0)
                let capTomo = cap.dividedBy(10 ** 18)
                BigNumber.config({ EXPONENTIAL_AT: [-100, 100] })
                let item = {
                    txHash: event.transactionHash,
                    blockNumber: event.blockNumber,
                    event: event.event,
                    blockHash: event.blockHash,
                    voter: voter,
                    owner: owner,
                    candidate: candidate,
                    cap: capTomo.toNumber()
                }
                listUser.push(item)
                if (listUser.length >= 5000) {
                    db.VoteHistory.insertMany(listUser)
                    listUser = []
                }
            }

            if (listUser.length > 0) {
                db.VoteHistory.insertMany(listUser)
            }
        })
        await Promise.all(pastEvent)
    } catch (e) {
        console.error(e)
    }

    // Calculate user vote for validator
    let histories = await db.VoteHistory.find({
        blockNumber: { $gte: startBlock, $lte: endBlock }
    }).sort({ blockNumber: 1 })

    console.log('There are %s histories in epoch %s', histories.length, epoch)
    for (let i = 0; i < histories.length; i++) {
        let history = histories[i]

        if (history.event === 'Propose') {
            let data = {
                voter: history.owner,
                candidate: history.candidate,
                epoch: Math.ceil(history.blockNumber / 900),
                voteAmount: history.cap
            }
            await db.UserVoteAmount.create(data)
        } else if (history.event === 'Vote') {
            let h = await db.UserVoteAmount.findOne({
                voter: history.voter,
                candidate: history.candidate
            }).sort({ epoch: -1 })
            await db.UserVoteAmount.updateOne({
                voter: history.voter,
                candidate: history.candidate,
                epoch: Math.floor(history.blockNumber / 900)
            }, {
                voteAmount: (h ? h.voteAmount : 0) + history.cap
            }, { upsert: true, new: true })
        } else if (history.event === 'Unvote') {
            let h = await db.UserVoteAmount.findOne({
                voter: history.voter,
                candidate: history.candidate
            }).sort({ epoch: -1 })
            await db.UserVoteAmount.updateOne({
                voter: history.voter,
                candidate: history.candidate,
                epoch: Math.floor(history.blockNumber / 900)
            }, {
                voteAmount: (h ? h.voteAmount : 0) - history.cap
            }, { upsert: true, new: true })
        } else if (history.event === 'Resign') {
            let h = await db.UserVoteAmount.findOne({
                voter: history.voter,
                candidate: history.candidate
            }).sort({ epoch: -1 })
            await db.UserVoteAmount.updateOne({
                voter: history.voter,
                candidate: history.candidate,
                epoch: Math.ceil(history.blockNumber / 900)
            }, {
                voteAmount: (h ? h.voteAmount : 0) - history.cap
            }, { upsert: true, new: true })
        }
    }

    console.log('Duplicate vote amount')
    // Find in history and duplicate to this epoch if not found
    let voteInEpoch = await db.UserVoteAmount.find({ epoch: epoch - 1 })
    let data = []
    for (let j = 0; j < voteInEpoch.length; j++) {
        let nextEpoch = await db.UserVoteAmount.findOne({
            voter: voteInEpoch[j].voter,
            epoch: epoch,
            candidate: voteInEpoch[j].candidate
        })
        if (!nextEpoch) {
            data.push({
                voter: voteInEpoch[j].voter,
                epoch: voteInEpoch[j].epoch + 1,
                voteAmount: epoch,
                candidate: voteInEpoch[j].candidate
            })
        }
    }
    if (data.length > 0) {
        console.log('Duplicate data to epoch %s', epoch)
        await db.UserVoteAmount.insertMany(data)
    }

    let totalSignNumber = 0

    let validators = []
    let voteHistory = await db.UserVoteAmount.find({ epoch: epoch })
    for (let i = 0; i < voteHistory.length; i++) {
        if (validators.indexOf(voteHistory[i].candidate) < 0) {
            validators.push(voteHistory[i].candidate)
        }
    }

    let rewardValidator = []
    let validatorSigners = []
    let validatorMap = validators.map(async (validator) => {
        validator = validator.toString().toLowerCase()
        let validatorSignNumber = await db.BlockSigner
            .countDocuments({
                blockNumber: { $gte: startBlock, $lte: endBlock },
                signers: validator
            })
        if (validatorSignNumber > 0) {
            totalSignNumber += validatorSignNumber
            validatorSigners.push({
                address: validator,
                signNumber: validatorSignNumber
            })
        }
    })
    await Promise.all(validatorMap)

    console.log('calculate reward for list validator ', new Date())
    let validatorFinal = validatorSigners.map(async (validator) => {
        let reward4group = totalReward.multipliedBy(validator.signNumber).dividedBy(totalSignNumber)
        let reward4validator = reward4group.multipliedBy(validatorRewardPercent).dividedBy(100)
        let reward4foundation = reward4group.multipliedBy(foundationRewardPercent).dividedBy(100)
        let reward4voter = reward4group.multipliedBy(voterRewardPercent).dividedBy(100)

        let blockRewardCalculate = (epoch + 1) * config.get('BLOCK_PER_EPOCH')

        let block = await db.Block.findOne({ number: blockRewardCalculate })
        let timestamp = new Date()
        if (!block) {
            let _block = await web3.eth.getBlock(blockRewardCalculate)
            if (_block) {
                timestamp = _block.timestamp * 1000
            }
        } else {
            timestamp = block.timestamp
        }

        await rewardVoterProcess(epoch, validator.address, validator.signNumber, reward4voter.toString(), timestamp)

        let ownerValidator = await validatorContract.methods.getCandidateOwner(validator.address).call()
        ownerValidator = ownerValidator.toString().toLowerCase()

        let lockBalance = await validatorContract.methods.getVoterCap(validator.address, ownerValidator).call()
        await rewardValidator.push({
            epoch: epoch,
            startBlock: startBlock,
            endBlock: endBlock,
            address: ownerValidator,
            validator: validator.address,
            reason: 'MasterNode',
            lockBalance: new BigNumber(lockBalance).toString(),
            reward: reward4validator.toString(),
            rewardTime: timestamp,
            signNumber: validator.signNumber
        })

        // Reward for foundation
        await rewardValidator.push({
            epoch: epoch,
            startBlock: startBlock,
            endBlock: endBlock,
            address: contractAddress.foundation,
            validator: validator.address,
            reason: 'Foundation',
            lockBalance: 0,
            reward: reward4foundation.toString(),
            rewardTime: timestamp,
            signNumber: validator.signNumber
        })
    })
    await Promise.all(validatorFinal)
    if (rewardValidator.length > 0) {
        await db.Reward.insertMany(rewardValidator)
    }
    console.log('End process', new Date())
    process.exit(1)
}

async function rewardVoterProcess (epoch, validator, validatorSignNumber, totalReward, rewardTime) {
    if (!rewardTime) {
        rewardTime = new Date()
    }
    totalReward = new BigNumber(totalReward)
    console.log('Process reward for voter of validator', validator)

    let endBlock = parseInt(epoch) * config.get('BLOCK_PER_EPOCH')
    let startBlock = endBlock - config.get('BLOCK_PER_EPOCH') + 1

    try {
        let voteEpoch = await db.UserVoteAmount.find({ epoch: epoch, candidate: validator })
        let totalVoterCap = 0
        for (let i = 0; i < voteEpoch.length; i++) {
            totalVoterCap += voteEpoch[i].voteAmount
        }
        // console.log('total voter cap', totalVoterCap, validator)
        totalVoterCap = new BigNumber(totalVoterCap)

        let rewardVoter = []
        for (let i = 0; i < voteEpoch.length; i++) {
            let voterAddress = voteEpoch[i].voter
            let voterAmount = new BigNumber(voteEpoch[i].voteAmount)
            if (String(voterAmount) !== '0') {
                let reward = totalReward.multipliedBy(voterAmount).dividedBy(totalVoterCap)

                await rewardVoter.push({
                    epoch: epoch,
                    startBlock: startBlock,
                    endBlock: endBlock,
                    address: voterAddress,
                    validator: validator,
                    reason: 'Voter',
                    lockBalance: voterAmount.toString(),
                    reward: reward.toString(),
                    rewardTime: rewardTime,
                    signNumber: validatorSignNumber
                })
                if (rewardVoter.length === 5000) {
                    await db.Reward.insertMany(rewardVoter)
                    rewardVoter = []
                }
            }
        }

        if (rewardVoter.length > 0) {
            await db.Reward.insertMany(rewardVoter)
        }
    } catch (e) {
        console.error(e)
        console.error('error voter reward of validator', validator, 'Auto re-calculate')
        await rewardVoterProcess(epoch, validator, validatorSignNumber, totalReward, rewardTime)
    }
}

module.exports = { epochReward }