#!/usr/bin/env node

const createError = require('http-errors')

const precedenceDefaults = require('../../core/src/defaults')
const PrecedenceError = require('../../core/src/errors').PrecedenceError
const sha256 = require('../../core/src/utils').sha256

const defaults = {
  limit: 1000000,
  port: 9000
}

const log = (string) => console.log(`LOG    - ${new Date().toISOString()} - ${string}`)

const api = fn => async (req, res) => {
  let data
  let error
  try {
    data = await fn(req, res)
  } catch (e) {
    if (e.statusCode) {
      error = e
    } else if (e instanceof PrecedenceError) {
      error = createError(
        e.status,
        (e.message && e.message.length > 0) && e.message || null,
        {code: e.code, data: e.data}
      )
    } else {
      console.error(e)
      error = createError(500)
    }
  } finally {
    if (!res.headersSent) {
      const result = {
        took: Date.now() - req._startTime,
        status: res.statusCode || 200
      }
      if (error) {
        res.status(error.statusCode)
        result.status = error.statusCode
        result.error = {
          code: error.code || 1,
          message: error.message,
        }
        if (error.data) {
          result.error.data = error.data
        }
      } else if (data) {
        result.data = data
      }
      res.set('Content-Type', 'application/json; charset=utf-8')
      res.send(req.query.pretty === "true" ? `${JSON.stringify(result, null, 2)}\n` : result)
    }
  }
}

require('../../common/src/').run('precedence-api', {
  _help: sections => {
    sections.splice(0, 0, {
      content: [
        'Welcome in the {bold.italic precedence} REST API.',
        'Visit "https://github.com/inblocks/precedence" to know more about {bold.italic precedence}.'
      ]
    })
    return sections
  },
  _options: [{
    name: 'block-cron',
    type: String,
    description: 'TODO example: "* * * * *" to create a block every minute'
  }, {
    name: 'block-no-empty',
    type: Boolean,
    description: 'TODO'
  }, {
    name: 'block-max',
    type: Number,
    description: 'TODO'
  }, {
    name: 'limit',
    type: Number,
    description: 'TODO',
  }, {
    name: 'namespace',
    type: String,
    description: `TODO (default: ${precedenceDefaults.namespace})`,
    defaultValue: precedenceDefaults.namespace
  }, {
    name: 'port',
    type: Number,
    description: `TODO (default: ${defaults.port})`,
    defaultValue: defaults.port
  }, {
    name: 'redis',
    type: String,
    description: `TODO (default: ${precedenceDefaults.redis})`,
    defaultValue: precedenceDefaults.redis
  }],
  _exec: (command, definitions, args, options) => {
    log(JSON.stringify(options))

    const precedence = require('../../core/src')(options)

    const getBlock = () => api(req => precedence.getBlock(req.params.id))

    const app = require('express')()

    app.use(require('morgan')('ACCESS - :date[iso] - :remote-addr ":method :url" :status :res[content-length] ":user-agent"'))

    app.get('/records/:id', api(req => precedence.getRecord(req.params.id)))
    app.post('/records', require('body-parser').raw({
      type: () => true,
      limit: options.limit || defaults.limit
    }), api(async (req, res) => {
      if (req.headers['content-type'] && req.headers['content-type'].toLowerCase() !== 'application/octet-stream') {
        throw createError(415, `Unsupported media type "${req.headers['content-type']}"`)
      }
      const hash = sha256(Buffer.isBuffer(req.body) && req.body || Buffer.from([]))
      if (req.query.hash && req.query.hash !== hash) {
        throw createError(400, `Provided SHA-256 hexadecimal string "${req.query.hash}" mismatches the computed: "${hash}"`, {
          data: {
            provided: req.query.hash,
            computed: hash
          }
        })
      }
      const chains = Array.isArray(req.query.chain) ? req.query.chain : (req.query.chain && [req.query.chain] || [])
      const previous = Array.isArray(req.query.previous) ? req.query.previous : (req.query.previous && [req.query.previous] || [])
      const id = req.query.id
      const data = req.query.store === "true" && req.body || undefined
      return await precedence.createRecords([{
        hash,
        chains,
        previous,
        id,
        data
      }]).then(result => {
        res.status(201)
        return result
      })
    }))
    app.delete('/records/:id', api(req => precedence.deleteRecord(req.params.id, req.query.recursive === "true")))

    app.get('/chains/:chain', api(req => precedence.getLastRecord(req.params.chain)))
    app.delete('/chains/:chain', api(async req => precedence.deleteChain(req.params.chain)))

    app.get('/blocks', getBlock()) //     get latest
    app.get('/blocks/:id', getBlock()) // get by root or index
    app.post('/blocks', api((req, res) => {
      const empty = req.query['no-empty'] !== "true"
      const max = req.query.max && Number(req.query.max)
      return precedence.createBlock(empty, max).then(result => {
        res.status(result && 201 || 200)
        return result
      })
    }))

    app.all('*', api(() => Promise.reject(createError(404))))
    // DON'T REMOVE USELESS "next" PARAMETER -> IT IS USEFUL TO CATCH ERRORS :-)
    app.use((error, req, res, next) => api(() => Promise.reject(error))(req, res))

    require('http').createServer(app)
      .listen(options.port || defaults.port, '0.0.0.0', () => {
        log(`listen on 0.0.0.0:${options.port || defaults.port}`)
        if (options['block-cron']) {
          const CronJob = require('cron').CronJob
          let isRunning = false
          let restart = true
          new CronJob({
            cronTime: options['block-cron'],
            onTick: async function run () {
              if (isRunning) {
                restart = true
                return
              }
              isRunning = true
              let count = -1
              do {
                const block = await precedence.createBlock(count === -1 ? !options['block-no-empty'] : false, options['block-max'])
                log(`block: ${JSON.stringify(block)}`)
                if (!block) {
                  break
                }
                count = block.count
              } while (options['block-max'] && count === options['block-max'])
              isRunning = false
              if (restart) {
                restart = false
                run().finally()
              }
            }
          }).start()
        }
      })
      .on('error', (e) => {
        console.error(e)
        process.exit(1)
      })
    return new Promise(() => null)
  }
})