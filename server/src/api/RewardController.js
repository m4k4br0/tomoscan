import { Router } from 'express'
import { paginate } from '../helpers/utils'
import db from '../models'
const BigNumber = require('bignumber.js')
const logger = require('../helpers/logger')
const { check, validationResult } = require('express-validator/check')

const RewardController = Router()

RewardController.get('/rewards/:slug', [
    check('limit').optional().isInt({ max: 50 }).withMessage('Limit is less than 50 items per page'),
    check('page').optional().isInt().withMessage('Require page is number'),
    check('slug').exists().isLength({ min: 42, max: 42 }).withMessage('Account address is incorrect.')
], async (req, res) => {
    let errors = validationResult(req)
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() })
    }
    let address = req.params.slug
    address = address.toLowerCase()
    try {
        let params = {}
        if (address) {
            params.query = { address: address }
        }

        let acc = await db.SpecialAccount.findOne({ hash: address })
        let total = null
        if (acc) {
            total = acc.rewardCount
        }
        params.sort = { epoch: -1 }
        let data = await paginate(req, 'Reward', params, total)

        return res.json(data)
    } catch (e) {
        logger.warn('Cannot find reward of address %s. Error %s', address, e)
        return res.status(500).json({ errors: { message: 'Something error!' } })
    }
})

RewardController.get('/rewards/epoch/:epochNumber', [
    check('limit').optional().isInt({ max: 50 }).withMessage('Limit is less than 50 items per page'),
    check('page').optional().isInt().withMessage('Require page is number'),
    check('epochNumber').isInt().exists().withMessage('Epoch number is require')
], async (req, res) => {
    let errors = validationResult(req)
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() })
    }
    let epochNumber = req.params.epochNumber || 0
    try {
        let params = {}
        params.query = { epoch: epochNumber }
        let reason = req.query.reason
        if (reason === 'voter') {
            params.query = Object.assign({}, params.query,
                { reason: { $ne: 'Foundation' } })
        } else if (reason === 'foundation') {
            params.query = Object.assign({}, params.query,
                { reason: 'Foundation' })
        }
        let data = await paginate(req, 'Reward', params)

        return res.json(data)
    } catch (e) {
        logger.warn('Cannot find reward of epoch %s. Error %s', epochNumber, e)
        return res.status(500).json({ errors: { message: 'Something error!' } })
    }
})

RewardController.get('/rewards/total/:slug/:fromEpoch/:toEpoch', [
    check('slug').exists().isLength({ min: 42, max: 42 }).withMessage('Account address is incorrect.'),
    check('fromEpoch').exists().isInt().withMessage('From epoch is require'),
    check('toEpoch').exists().isInt().withMessage('To epoch is require')
], async (req, res) => {
    let errors = validationResult(req)
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() })
    }
    try {
        let address = req.params.slug
        let fromEpoch = req.params.fromEpoch
        let toEpoch = req.params.toEpoch
        address = address.toLowerCase()
        let acc = await db.Account.findOne({ hash: address })
        if (!acc) {
            return res.json({ address: address, totalReward: 0 })
        }

        let rewards = await db.Reward.find({
            address: address,
            epoch: { $gte: fromEpoch, $lte: toEpoch }
        })
        let total = new BigNumber(0)
        for (let i = 0; i < rewards.length; i++) {
            let rw = new BigNumber(rewards[i].reward)
            rw = rw.dividedBy(10 ** 18)
            total = total.plus(rw)
        }

        return res.json({ address: address, totalReward: total.toNumber() })
    } catch (e) {
        logger.warn(e)
        return res.status(400).send()
    }
})

RewardController.post('/expose/rewards', async (req, res) => {
    try {
        const address = req.body.address || null
        const owner = req.body.owner || null
        const reason = req.body.reason || null
        let limit = !isNaN(req.body.limit) ? parseInt(req.body.limit) : 200
        if (limit > 200) {
            limit = 200
        }
        let page = !isNaN(req.body.page) ? parseInt(req.body.page) : 1
        const skip = limit * (page - 1)
        let params = {}

        if (owner) {
            params = {
                validator: address.toLowerCase(),
                address: owner.toLowerCase()
            }
        } else {
            params = {
                address: address.toLowerCase()
            }
        }

        if (reason) {
            params = Object.assign(params, { reason: reason })
        }
        const totalReward = db.Reward.countDocuments(params)

        const reward = await db.Reward.find(params).sort({ epoch: -1 }).limit(limit).skip(skip).exec()

        res.send({
            items: reward,
            total: await totalReward
        })
    } catch (e) {
        logger.warn(e)
        return res.status(400).send()
    }
})

RewardController.post('/expose/signNumber/:epochNumber', [
    check('epochNumber').exists().isInt().withMessage('Epoch number is require & need a number')
], async (req, res) => {
    let errors = validationResult(req)
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() })
    }
    try {
        let epoch = req.params.epochNumber || null
        let signNumbers = await db.EpochSign.find({ epoch: epoch })

        return res.json(signNumbers)
    } catch (e) {
        logger.warn(e)
        return res.status(400).send()
    }
})

export default RewardController
