/* Copyright (c) 2010-2016 Richard Rodger and other contributors, MIT License */
'use strict'

// Node API modules
var Assert = require('assert')
var Events = require('events')
var Util = require('util')

// External modules.
var _ = require('lodash')
var Eraro = require('eraro')
var GateExecutor = require('gate-executor')
var Jsonic = require('jsonic')
var Lrucache = require('lru-cache')
var Makeuse = require('use-plugin')
var Nid = require('nid')
var Norma = require('norma')
var Patrun = require('patrun')
var Parambulator = require('parambulator')
var Stats = require('rolling-stats')
var Zig = require('zig')

// Internal modules.
var Actions = require('./lib/actions')
var Common = require('./lib/common')
var Errors = require('./lib/errors')
var Legacy = require('./lib/legacy')
var Optioner = require('./lib/optioner')
var Package = require('./package.json')
var Plugins = require('./lib/plugins')
var Print = require('./lib/print')
var Transport = require('./lib/transport')

// Shortcuts
var arrayify = Function.prototype.apply.bind(Array.prototype.slice)
var errlog = Common.make_standard_err_log_entry
var actlog = Common.make_standard_act_log_entry

var internals = {
  error: Eraro({
    package: 'seneca',
    msgmap: Errors,
    override: true
  }),
  schema: Parambulator({
    tag: { string$: true },
    idlen: { integer$: true },
    timeout: { integer$: true },
    errhandler: { function$: true }
  }, {
    topname: 'options',
    msgprefix: 'seneca({...}): '
  }),
  defaults: {
    // Tag this Seneca instance, will be appended to instance identifier.
    tag: '-',

    // Standard length of identifiers for actions.
    idlen: 12,

    // Standard timeout for actions.
    timeout: 22222,

    // Register (true) default plugins. Set false to not register when
    // using custom versions.
    default_plugins: {
      basic: true,
      repl: true,
      transport: true
    },

    // Debug settings.
    debug: {
      // Throw (some) errors from seneca.act.
      fragile: false,

      // Fatal errors ... aren't fatal. Not for production!
      undead: false,

      // Print debug info to console
      print: {
        // Print options. Best used via --seneca.print.options.
        options: false
      },

      // Trace action caller and place in args.caller$.
      act_caller: false,

      // Shorten all identifiers to 2 characters.
      short_logs: false,

      // Record and log callpoints (calling code locations).
      callpoint: false
    },

    // Enforce strict behaviours. Relax when backwards compatibility needed.
    strict: {
      // Action result must be a plain object.
      result: true,

      // Delegate fixedargs override action args.
      fixedargs: true,

      // Adding a pattern overrides existing pattern only if matches exactly.
      add: false,

      // If no action is found and find is false,
      // then no error returned along with empty object
      find: true,

      // Maximum number of times an action can call itself
      maxloop: 11
    },

    // Action cache. Makes inbound messages idempotent.
    actcache: {
      active: true,
      size: 11111
    },

    // Action executor tracing. See gate-executor module.
    trace: {
      act: false,
      stack: false,
      unknown: true
    },

    // Action statistics settings. See rolling-stats module.
    stats: {
      size: 1024,
      interval: 60000,
      running: false
    },

    // Wait time for plugins to close gracefully.
    deathdelay: 11111,

    // Default seneca-admin settings.
    admin: {
      local: false,
      prefix: '/admin'
    },

    // Plugin settings
    plugin: {},

    // Internal functionality. Reserved for objects and funtions only.
    internal: {

      // Close instance on these signals, if true.
      // TODO: move to 'system' top level property
      close_signals: {
        SIGHUP: true,
        SIGTERM: true,
        SIGINT: true,
        SIGBREAK: true
      },

      // seneca.add uses catchall (pattern='') prior
      // TODO: move to 'system' top level property
      catchall: false
    },

    // Log status at periodic intervals.
    status: {
      interval: 60000,

      // By default, does not run.
      running: false
    },

    // zig module settings for seneca.start() chaining.
    zig: {},

    pin: {
      // run pin function without waiting for pin event
      immediate: false
    },

    // backwards compatibility settings
    legacy: {

      // use old error codes, until version 3.x
      error_codes: true,

      // use parambulator for message validation, until version 3.x
      validate: true,

      // use old logging, until version 3.x
      logging: true
    }
  }
}

var seneca_util = {
  deepextend: Common.deepextend,
  recurse: Common.recurse,
  clean: Common.clean,
  copydata: Common.copydata,
  nil: Common.nil,
  pattern: Common.pattern,
  print: Common.print,
  pincanon: Common.pincanon,
  router: function () { return Patrun() },

  // DEPRECATED
  argprops: Common.argprops
}

// Seneca is an EventEmitter.
function Seneca () {
  Events.EventEmitter.call(this)
  this.setMaxListeners(0)
}
Util.inherits(Seneca, Events.EventEmitter)


module.exports = function init (seneca_options, more_options) {
  // Create instance.
  var seneca = make_seneca(_.extend({}, seneca_options, more_options))
  var options = seneca.options()

  seneca.log.info({kind: 'notice', notice: 'hello'})

  // The 'internal' key of options is reserved for objects and functions
  // that provide functionality, and are thus not really printable
  seneca.log.debug({kind: 'notice', options: _.omit(options, ['internal'])})

  if (options.debug.print.options) {
    console.log('\nSeneca Options (' + root.id + '): before plugins\n' + '===\n')
    console.log(Util.inspect(options, { depth: null }))
    console.log('')
  }

  // TODO: these are core API and should not be decorations
  seneca.decorate('hasplugin', Plugins.api_decorations.hasplugin)
  seneca.decorate('findplugin', Plugins.api_decorations.findplugin)
  seneca.decorate('plugins', Plugins.api_decorations.plugins)


  if (options.legacy.validate) {
    seneca.use(require('seneca-parambulator'))
  }

  // HACK: makes this sync - FIX: use preload
  if (options.default_plugins.repl) {
    require('seneca-repl').call(seneca, options.repl)
  }

  // Register default plugins, unless turned off by options.
  if (options.default_plugins.basic) { seneca.use(require('seneca-basic')) }
  if (options.default_plugins.transport) { seneca.use(require('seneca-transport')) }

  // Register plugins specified in options.
  _.each(options.plugins, function (plugindesc) {
    seneca.use(plugindesc)
  })

  return seneca
}

// Expose Seneca prototype for easier monkey-patching
module.exports.Seneca = Seneca

// To reference builtin loggers when defining logging options.
module.exports.loghandler = Legacy.loghandler

// Makes require('seneca').use(...) work by creating an on-the-fly instance.
module.exports.use = function () {
  var instance = module.exports()
  return instance.use.apply(instance, arrayify(arguments))
}

module.exports.util = seneca_util


// Mostly for testing.
if (require.main === module) {
  module.exports()
}

// Create a new Seneca instance.
// * _initial_options_ `o` &rarr; instance options
function make_seneca (initial_options) {
  initial_options = initial_options || {} // ensure defined

  // Create a private context.
  var private$ = make_private()

  // Create a new root Seneca instance.
  var root = new Seneca()
  root.make_log = make_log

  // expose private for plugins
  root.private$ = private$

  // Create option resolver.
  private$.optioner = Optioner(
    initial_options.module || module.parent || module,
    internals.defaults)

  // Not needed after this point, and screws up debug printing.
  delete initial_options.module

  // Define options
  var so = private$.optioner.set(initial_options)

  // TODO: remove parambulator dep from Seneca; do this another way
  internals.schema.validate(so, function (err) {
    if (err) {
      throw err
    }
  })

  // Create internal tools.
  var actnid = Nid({length: so.idlen})
  var refnid = function () { return '(' + actnid() + ')' }

  // These need to come from options as required during construction.
  so.internal.actrouter = so.internal.actrouter || Patrun({ gex: true })
  so.internal.subrouter = so.internal.subrouter || Patrun({ gex: true })

  var callpoint = make_callpoint(so.debug.callpoint)

  // Define public member variables.
  root.root = root
  root.start_time = Date.now()
  root.fixedargs = {}
  root.context = {}
  root.version = Package.version

  // Seneca methods. Official API.
  root.add = api_add // Add a message pattern and action.
  root.act = api_act // Perform action that matches pattern.
  root.sub = api_sub // Subscribe to a message pattern.
  root.use = api_use // Define a plugin.
  root.listen = Transport.listen(callpoint) // Listen for inbound messages.
  root.client = Transport.client(callpoint) // Send outbound messages.
  root.export = api_export // Export plain objects from a plugin.
  root.has = Actions.has // True if action pattern defined.
  root.find = Actions.find // Find action by pattern
  root.list = Actions.list // List (a subset of) action patterns.
  root.ready = api_ready // Callback when plugins initialized.
  root.close = api_close // Close and shutdown plugins.
  root.options = api_options // Get and set options.
  root.start = api_start // Start an action chain.
  root.error = api_error // Set global error handler.
  root.decorate = api_decorate // Decorate seneca object with functions

  // Method aliases.
  root.hasact = root.has

  // Non-API methods.
  root.register = Plugins.register(so, callpoint)
  root.depends = api_depends
  root.pin = api_pin
  root.act_if = api_act_if
  root.wrap = api_wrap
  root.seneca = api_seneca
  root.fix = api_fix
  root.delegate = api_delegate

  // Legacy API; Deprecated.
  root.findact = root.find

  // DEPRECATED
  root.fail = Legacy.fail(so)

  // Identifier generator.
  root.idgen = Nid({length: so.idlen})
  so.tag = so.tag || internals.defaults.tag
  so.tag = so.tag === 'undefined' ? internals.defaults.tag : so.tag

  // Create a unique identifer for this instance.
  root.id = root.idgen() +
    '/' +
    root.start_time +
    '/' +
    process.pid +
    '/' +
    root.version +
    '/' +
    so.tag

  if (so.debug.short_logs || so.log.short) {
    so.idlen = 2
    root.idgen = Nid({length: so.idlen})
    root.id = root.idgen() + '/' + so.tag
  }

  root.fullname = 'Seneca/' + root.id

  root.die = Common.makedie(root, {
    type: 'sys',
    plugin: 'seneca',
    tag: root.version,
    id: root.id,
    callpoint: callpoint
  })

  root.util = seneca_util


  // Configure logging
  private$.exports = { options: Common.deepextend({}, so) }
  private$.decorations = {}

  private$.logger = load_logger(root, so.internal.logger)
  root.log = make_log(root, default_log_modifier)


  // Error events are fatal, unless you're undead.  These are not the
  // same as action errors, these are unexpected internal issues.
  root.on('error', root.die)

  private$.ge =
    GateExecutor({
      timeout: so.timeout
    })
    .clear(action_queue_clear)
    .start()

  // setup status log
  if (so.status.interval > 0 && so.status.running) {
    private$.stats = private$.stats || {}
    setInterval(function () {
      root.log.info({
        kind: 'status',
        alive: (Date.now() - private$.stats.start),
        act: private$.stats.act
      })
    }, so.status.interval)
  }

  if (so.stats) {
    private$.timestats = new Stats.NamedStats(so.stats.size, so.stats.interval)

    if (so.stats.running) {
      setInterval(function () {
        private$.timestats.calculate()
      }, so.stats.interval)
    }
  }

  private$.plugins = {}
  private$.plugin_order = { byname: [], byref: [] }
  private$.use = Makeuse({
    prefix: 'seneca-',
    module: module,
    msgprefix: false,
    builtin: ''
  })

  private$.actcache = (so.actcache.active
    ? Lrucache({ max: so.actcache.size })
    : { set: _.noop })

  private$.actrouter = so.internal.actrouter
  private$.subrouter = so.internal.subrouter

  root.toString = api_toString

  private$.action_modifiers = []
  private$.ready_list = []


  function api_depends () {
    var self = this

    var args = Norma('{pluginname:s deps:a? moredeps:s*}', arguments)

    var deps = args.deps || args.moredeps

    _.every(deps, function (depname) {
      if (!_.includes(private$.plugin_order.byname, depname) &&
        !_.includes(private$.plugin_order.byname, 'seneca-' + depname)) {
        self.die(internals.error('plugin_required', { name: args.pluginname, dependency: depname }))
        return false
      }
      else return true
    })
  }

  function api_export (key) {
    var self = this

    // Legacy aliases
    if (key === 'util') {
      key = 'basic'
    }

    var exportval = private$.exports[key]
    if (!exportval) {
      return self.die(internals.error('export_not_found', {key: key}))
    }

    return exportval
  }

  // TODO: DEPRECATE
  function api_pin (pattern, pinopts) {
    var thispin = this

    pattern = _.isString(pattern) ? Jsonic(pattern) : pattern

    var methodkeys = []
    for (var key in pattern) {
      if (/[\*\?]/.exec(pattern[key])) {
        methodkeys.push(key)
      }
    }

    function make_pin (pattern) {
      var api = {
        toString: function () {
          return 'pin:' + Common.pattern(pattern) + '/' + thispin
        }
      }

      var calcPin = function () {
        var methods = private$.actrouter.list(pattern)

        methods.forEach(function (method) {
          var mpat = method.match

          var methodname = ''
          for (var mkI = 0; mkI < methodkeys.length; mkI++) {
            methodname += ((mkI > 0 ? '_' : '')) + mpat[methodkeys[mkI]]
          }

          api[methodname] = function (args, cb) {
            var si = this && this.seneca ? this : thispin

            var fullargs = _.extend({}, args, mpat)
            si.act(fullargs, cb)
          }

          api[methodname].pattern$ = method.match
          api[methodname].name$ = methodname
        })

        if (pinopts && pinopts.include) {
          for (var i = 0; i < pinopts.include.length; i++) {
            var methodname = pinopts.include[i]
            if (thispin[methodname]) {
              api[methodname] = Common.delegate(thispin, thispin[methodname])
            }
          }
        }
      }

      var opts = {}
      _.defaults(opts, pinopts, so.pin)

      if (private$._isReady || opts.immediate) {
        calcPin()
      }
      else {
        root.once('pin', calcPin)
      }

      return api
    }

    return make_pin(pattern)
  }


  function api_sub () {
    var self = this

    var subargs = Common.parsePattern(self, arguments, 'action:f actmeta:o?')
    var pattern = subargs.pattern
    if (pattern.in$ == null &&
      pattern.out$ == null &&
      pattern.error$ == null &&
      pattern.cache$ == null &&
      pattern.default$ == null &&
      pattern.client$ == null) {
      pattern.in$ = true
    }

    if (!private$.handle_sub) {
      private$.handle_sub = function (args, result) {
        args.meta$ = args.meta$ || {}

        if (args.meta$.entry !== true) {
          return
        }

        var subfuncs = private$.subrouter.find(args)

        if (subfuncs) {
          args.meta$.sub = subfuncs.pattern

          _.each(subfuncs, function (subfunc) {
            try {
              subfunc.call(self, args, result)
            }
            catch (ex) {
              // TODO: not really satisfactory
              var err = internals.error(ex, 'sub_function_catch', { args: args, result: result })
              self.log.error(errlog(err, {
                kind: 'sub',
                msg: args,
                actid: args.meta$.id
              }))
            }
          })
        }
      }

      // TODO: other cases

      // Subs are triggered via events
      self.on('act-in', annotate('in$', private$.handle_sub))
      self.on('act-out', annotate('out$', private$.handle_sub))
    }

    function annotate (prop, handle_sub) {
      return function (args, result) {
        args = _.clone(args)
        result = _.clone(result)
        args[prop] = true
        handle_sub(args, result)
      }
    }

    var subs = private$.subrouter.find(pattern)
    if (!subs) {
      private$.subrouter.add(pattern, subs = [])
      subs.pattern = Common.pattern(pattern)
    }
    subs.push(subargs.action)

    return self
  }

  // ### seneca.add
  // Add an message pattern and action function.
  //
  // `seneca.add(pattern, action)`
  //    * _pattern_ `o|s` &rarr; pattern definition
  //    * _action_ `f` &rarr; pattern action function
  //
  // `seneca.add(pattern_string, pattern_object, action)`
  //    * _pattern_string_ `s` &rarr; pattern definition as jsonic string
  //    * _pattern_object_ `o` &rarr; pattern definition as object
  //    * _action_ `f` &rarr; pattern action function
  //
  // The pattern is defined by the top level properties of the
  // _pattern_ parameter.  In the case where the pattern is a string,
  // it is first parsed by
  // [jsonic](https://github.com/rjrodger/jsonic)
  //
  function api_add () {
    var self = this
    var args = Common.parsePattern(self, arguments, 'action:f? actmeta:o?')

    var raw_pattern = args.pattern

    var action = args.action || function (msg, done) {
      done.call(this, null, msg.default$ || null)
    }

    var actmeta = args.actmeta || {}

    actmeta.raw = _.cloneDeep(raw_pattern)

    // TODO: refactor plugin name, tag and fullname handling.
    actmeta.plugin_name = actmeta.plugin_name || 'root$'
    actmeta.plugin_fullname = actmeta.plugin_fullname ||
      actmeta.plugin_name +
      ((actmeta.plugin_tag === '-' ? void 0 : actmeta.plugin_tag)
       ? '/' + actmeta.plugin_tag : '')

    var add_callpoint = callpoint()
    if (add_callpoint) {
      actmeta.callpoint = add_callpoint
    }

    actmeta.sub = !!raw_pattern.sub$
    actmeta.client = !!raw_pattern.client$

    // Deprecate a pattern by providing a string message using deprecate$ key.
    actmeta.deprecate = raw_pattern.deprecate$

    var strict_add = (raw_pattern.strict$ && raw_pattern.strict$.add !== null)
      ? !!raw_pattern.strict$.add : !!so.strict.add

    var internal_catchall = (raw_pattern.internal$ && raw_pattern.internal$.catchall !== null)
      ? !!raw_pattern.internal$.catchall : !!so.internal.catchall

    var pattern = self.util.clean(raw_pattern)

    if (!_.keys(pattern)) {
      throw internals.error('add_empty_pattern', {args: Common.clean(args)})
    }

    var pattern_rules = _.clone(action.validate || {})
    _.each(pattern, function (v, k) {
      if (_.isObject(v)) {
        pattern_rules[k] = _.clone(v)
        delete pattern[k]
      }
    })

    var addroute = true

    // TODO: deprecate
    actmeta.args = _.clone(pattern)

    actmeta.rules = pattern_rules

    actmeta.id = refnid()
    actmeta.func = action

    // Canonical string form of the action pattern.
    actmeta.pattern = Common.pattern(pattern)

    // Canonical object form of the action pattern.
    actmeta.msgcanon = Jsonic(actmeta.pattern)

    var priormeta = self.find(pattern)

    if (priormeta) {
      if (!internal_catchall && '' === priormeta.pattern) {
        priormeta = null
      }

      // only exact action patterns are overridden
      // use .wrap for pin-based patterns
      else if (strict_add && priormeta.pattern !== actmeta.pattern) {
        priormeta = null
      }
    }

    if (priormeta) {
      if (_.isFunction(priormeta.handle)) {
        priormeta.handle(args.pattern, action)
        addroute = false
      }
      else {
        actmeta.priormeta = priormeta
      }
      actmeta.priorpath = priormeta.id + ';' + priormeta.priorpath
    }
    else {
      actmeta.priorpath = ''
    }

    // FIX: need a much better way to support layered actions
    // this ".handle" hack is just to make seneca.close work
    if (action && actmeta && _.isFunction(action.handle)) {
      actmeta.handle = action.handle
    }

    private$.stats.actmap[actmeta.pattern] =
      private$.stats.actmap[actmeta.pattern] || make_action_stats(actmeta)

    actmeta = modify_action(self, actmeta)

    if (addroute) {
      self.log.debug({
        kind: 'add',
        case: actmeta.sub ? 'SUB' : 'ADD',
        id: actmeta.id,
        pattern: actmeta.pattern,
        name: action.name,
        callpoint: callpoint
      })

      private$.actrouter.add(pattern, actmeta)
    }

    return self
  }


  function make_action_stats (actmeta) {
    return {
      id: actmeta.id,
      plugin: {
        full: actmeta.plugin_fullname,
        name: actmeta.plugin_name,
        tag: actmeta.plugin_tag
      },
      prior: actmeta.priorpath,
      calls: 0,
      done: 0,
      fails: 0,
      time: {}
    }
  }

  function modify_action (seneca, actmeta) {
    _.each(private$.action_modifiers, function (actmod) {
      actmeta = actmod.call(seneca, actmeta)
    })

    return actmeta
  }


  // TODO: deprecate
  root.findpins = root.pinact = function () {
    var pins = []
    var patterns = _.flatten(arrayify(arguments))

    _.each(patterns, function (pattern) {
      pattern = _.isString(pattern) ? Jsonic(pattern) : pattern
      pins = pins.concat(_.map(private$.actrouter.list(pattern),
        function (desc) {
          return desc.match
        }
      ))
    })

    return pins
  }

  function api_act_if () {
    var self = this
    var args = Norma('{execute:b actargs:.*}', arguments)

    if (args.execute) {
      return self.act.apply(self, args.actargs)
    }
    else return self
  }

  // Perform an action. The properties of the first argument are matched against
  // known patterns, and the most specific one wins.
  function api_act () {
    var self = this
    var spec = Common.parsePattern(self, arrayify(arguments), 'done:f?')
    var args = spec.pattern
    var actdone = spec.done
    args = _.extend(args, self.fixedargs)

    if (so.debug.act_caller) {
      args.caller$ = '\n    Action call arguments and location: ' +
        (new Error(Util.inspect(args).replace(/\n/g, '')).stack)
          .replace(/.*\/seneca\.js:.*\n/g, '')
          .replace(/.*\/seneca\/lib\/.*\.js:.*\n/g, '')
    }

    do_act(self, null, null, args, actdone)

    return self
  }


  function api_wrap (pin, meta, wrapper) {
    var pinthis = this

    wrapper = _.isFunction(meta) ? meta : wrapper
    meta = _.isFunction(meta) ? {} : meta

    pin = _.isArray(pin) ? pin : [pin]
    _.each(pin, function (p) {
      _.each(pinthis.findpins(p), function (actpattern) {
        pinthis.add(actpattern, meta, wrapper)
      })
    })
  }

  var handleClose = function () {
    root.close(function (err) {
      if (err) {
        Common.console_error(err)
      }

      process.exit(err ? (err.exit === null ? 1 : err.exit) : 0)
    })
  }

  // close seneca instance
  // sets public seneca.closed property
  function api_close (done) {
    var seneca = this

    seneca.ready(do_close)

    function do_close () {
      seneca.closed = true

      // cleanup process event listeners
      _.each(so.internal.close_signals, function (active, signal) {
        if (active) {
          process.removeListener(signal, handleClose)
        }
      })

      seneca.log.debug({kind: 'close', notice: 'start', callpoint: callpoint()})
      seneca.act('role:seneca,cmd:close,closing$:true', function (err) {
        seneca.log.debug(errlog(
          err, {kind: 'close', notice: 'end'}))

        seneca.removeAllListeners('act-in')
        seneca.removeAllListeners('act-out')
        seneca.removeAllListeners('act-err')
        seneca.removeAllListeners('pin')
        seneca.removeAllListeners('after-pin')
        seneca.removeAllListeners('ready')

        if (_.isFunction(done)) {
          return done.call(seneca, err)
        }
      })
    }
  }

  // useful when defining services!
  // note: has EventEmitter.once semantics
  // if using .on('ready',fn) it will be be called for each ready event
  function api_ready (ready) {
    var self = this

    setImmediate(function () {
      if (root.private$.ge.isclear()) {
        ready.call(self)
      }
      else {
        root.private$.ready_list.push(ready.bind(self))
      }
    })

    return self
  }

  // use('pluginname') - built-in, or provide calling code 'require' as seneca opt
  // use(require('pluginname')) - plugin object, init will be called
  // if first arg has property senecaplugin
  function api_use (arg0, arg1, arg2) {
    var self = this
    var plugindesc

    // Allow chaining with seneca.use('options', {...})
    // see https://github.com/rjrodger/seneca/issues/80
    if (arg0 === 'options') {
      self.options(arg1)
      return self
    }

    try {
      plugindesc = private$.use(arg0, arg1, arg2)
    }
    catch (e) {
      self.die(internals.error(e, 'plugin_' + e.code))
      return self
    }

    self.register(plugindesc)

    return self
  }

  // TODO: move repl functionality to seneca-repl

  root.inrepl = function () {
    var self = this

    self.on('act-out', function () {
      Legacy.loghandler.print.apply(null, arrayify(arguments))
    })

    self.on('error', function () {
      var args = arrayify(arguments)
      args.unshift('ERROR: ')
      Legacy.loghandler.print.apply(null, args)
    })
  }

  // Return self. Mostly useful as a check that this is a Seneca instance.
  function api_seneca () {
    return this
  }

  // Describe this instance using the form: Seneca/VERSION/ID
  function api_toString () {
    return this.fullname
  }

  function do_act (instance, actmeta, prior_ctxt, origargs, actdone) {
    var delegate = instance
    var args = _.clone(origargs)
    var callargs = args
    var actstats
    var act_callpoint = callpoint()
    var is_sync = _.isFunction(actdone)
    var id_tx = (args.id$ || args.actid$ || instance.idgen()).split('/')
    var tx =
          id_tx[1] ||
          origargs.tx$ ||
          instance.fixedargs.tx$ ||
          instance.idgen()
    var actid = (id_tx[0] || instance.idgen()) + '/' + tx
    var actstart = Date.now()

    args.default$ = args.default$ || (!so.strict.find ? {} : args.default$)
    prior_ctxt = prior_ctxt || { chain: [], entry: true, depth: 1 }
    actdone = actdone || _.noop


    // if previously seen message, provide previous result, and don't process again
    if (apply_actcache(instance, callargs, origargs, prior_ctxt, actdone, act_callpoint)) {
      return
    }

    var execute_action = function execute_action (act_instance, action_done) {
      actmeta = actmeta || act_instance.find(args, {catchall: so.internal.catchall})

      if (!executable_action(prior_ctxt, args, callargs, origargs,
                             actmeta, act_instance, action_done)) {
        return
      }

      validate_action_message(args, actmeta, function (err) {
        if (err) {
          return action_done.call(act_instance, err)
        }

        actstats = act_stats_call(actmeta.pattern)

        // build callargs
        // remove actid so that user manipulation of args for subsequent use does
        // not cause inadvertent hit on existing action
        delete callargs.id$
        delete callargs.actid$ // legacy alias

        callargs.meta$ = {
          id: actid,
          tx: tx,
          start: actstart,
          pattern: actmeta.pattern,
          action: actmeta.id,
          entry: prior_ctxt.entry,
          chain: prior_ctxt.chain,
          sync: is_sync,
          plugin_name: actmeta.plugin_name,
          plugin_tag: actmeta.plugin_tag
        }

        if (actmeta.deprecate) {
          instance.log.warn({
            kind: 'act',
            case: 'DEPRECATED',
            pattern: actmeta.pattern,
            notice: actmeta.deprecate,
            callpoint: act_callpoint})
        }

        var delegate =
              act_make_delegate(act_instance, tx, callargs, actmeta, prior_ctxt)

        action_done = action_done.bind(delegate)

        callargs = _.extend({}, callargs, delegate.fixedargs, {tx$: tx})

        if (!actmeta.sub) {
          delegate.log.debug(actlog(
            actmeta, prior_ctxt, callargs, origargs,
            { kind: 'act', case: 'IN' }))
        }

        delegate.emit('act-in', callargs)

        action_done.seneca = delegate

        if (root.closed && !callargs.closing$) {
          return action_done(
            internals.error('instance-closed',
                            {args: Common.clean(callargs)}))
        }

        delegate.good = function (out) {
          action_done(null, out)
        }

        delegate.bad = function (err) {
          action_done(err)
        }

        if (_.isFunction(delegate.on_act_in)) {
          delegate.on_act_in(actmeta, callargs)
        }

        actmeta.func.call(delegate, callargs, action_done)
      })
    }

    var act_done = function act_done (err) {
      delegate = this || delegate

      try {
        var actend = Date.now()

        prior_ctxt.depth--
        prior_ctxt.entry = prior_ctxt.depth <= 0

        if (prior_ctxt.entry === true && actmeta) {
          private$.timestats.point(actend - actstart, actmeta.pattern)
        }

        var result = arrayify(arguments)
        var call_cb = true

        var resdata = result[1]

        if (err == null &&
          resdata != null &&
          !(_.isPlainObject(resdata) ||
          _.isArray(resdata) ||
          !!resdata.entity$ ||
          !!resdata.force$
         ) &&
          so.strict.result) {
          // allow legacy patterns
          if (!(callargs.cmd === 'generate_id' ||
            callargs.note === true ||
            callargs.cmd === 'native' ||
            callargs.cmd === 'quickcode'
           )) {
            err = internals.error(
              'result_not_objarr', {
                pattern: actmeta.pattern,
                args: Util.inspect(Common.clean(callargs)).replace(/\n/g, ''),
                result: resdata
              })
          }
        }

        private$.actcache.set(actid, {
          result: result,
          actmeta: actmeta,
          when: Date.now()
        })

        if (err) {
          // TODO: is act_not_found an error for purposes of stats? probably not
          private$.stats.act.fails++

          if (actstats) {
            actstats.fails++
          }

          var out = act_error(instance, err, actmeta, result, actdone,
            actend - actstart, callargs, origargs, prior_ctxt, act_callpoint)

          if (args.fatal$) {
            return instance.die(out.err)
          }

          call_cb = out.call_cb
          result[0] = out.err

          if (delegate && _.isFunction(delegate.on_act_err)) {
            delegate.on_act_err(actmeta, result[0])
          }
        }
        else {
          instance.emit('act-out', callargs, result[1])
          result[0] = null

          delegate.log.debug(actlog(
            actmeta, prior_ctxt, callargs, origargs,
            { kind: 'act',
              case: 'OUT',
              duration: actend - actstart,
              result: result[1]
            }))

          if (_.isFunction(delegate.on_act_out)) {
            delegate.on_act_out(actmeta, result[1])
          }

          if (actstats) {
            private$.stats.act.done++
            actstats.done++
          }
        }

        try {
          if (call_cb) {
            actdone.apply(delegate, result) // note: err == result[0]
          }
        }

        // for exceptions thrown inside the callback
        catch (ex) {
          var formattedErr = ex
          // handle throws of non-Error values
          if (!Util.isError(ex)) {
            formattedErr = _.isObject(ex)
              ? new Error(Jsonic.stringify(ex))
              : new Error('' + ex)
          }

          callback_error(instance, formattedErr, actmeta, result, actdone,
            actend - actstart, callargs, origargs, prior_ctxt, act_callpoint)
        }
      }
      catch (ex) {
        instance.emit('error', ex)
      }
    }

    var guess_actmeta = delegate.find(args, {catchall: so.internal.catchall}) || {}

    var execute_action_instance = instance
    if (callargs.gate$) {
      execute_action_instance = instance.delegate()
      execute_action_instance.private$.ge =
        execute_action_instance.private$.ge.gate()
    }

    var execspec = {
      id: actid,
      description: guess_actmeta.pattern,
      fn: function (done) {
        try {
          execute_action(execute_action_instance, function () {
            act_done.apply(this, arguments)
            done()
          })
        }
        catch (e) {
          act_done.call(this, e)
          done()
        }
      },
      ontm: function (done) {
        act_done.call(execute_action_instance, new Error('[TIMEOUT]'))
      }
    }

    if ('number' === typeof args.timeout$) {
      execspec.tm = args.timeout$
    }

    execute_action_instance.private$.ge.add(execspec)
  }

  function executable_action (
    prior_ctxt,
    args,
    callargs,
    origargs,
    actmeta,
    act_instance,
    action_done
  ) {
    var err

    if (actmeta) {
      if (_.isArray(args.history$) && 0 < args.history$.length) {
        var repeat_count = _.filter(args.history$, _.matches({action: actmeta.id})).length

        if (so.strict.maxloop < repeat_count) {
          err = internals.error('act_loop', {
            pattern: actmeta.pattern,
            actmeta: actmeta,
            history: args.history$
          })
          action_done.call(act_instance, err)
          return false
        }
      }
    }

    // action pattern not found
    else {
      if (_.isPlainObject(args.default$) || _.isArray(args.default$)) {
        act_instance.log.debug(actlog(
          actmeta, prior_ctxt, callargs, origargs,
          {
            kind: 'act',
            case: 'DEFAULT'
          }))

        action_done.call(act_instance, null, args.default$)
        return false
      }

      var errcode = 'act_not_found'
      var errinfo = { args: Util.inspect(Common.clean(args)).replace(/\n/g, '') }

      if (!_.isUndefined(args.default$)) {
        errcode = 'act_default_bad'
        errinfo.xdefault = Util.inspect(args.default$)
      }

      err = internals.error(errcode, errinfo)

      // TODO: wrong approach - should always call action_done to complete
      // error would then include a fatal flag
      if (args.fatal$) {
        act_instance.die(err)
        return false
      }

      if (so.trace.unknown) {
        act_instance.log.warn(
          errlog(
            err, errlog(
              actmeta, prior_ctxt, callargs, origargs,
              {
                // kind is act as this log entry relates to an action
                kind: 'act',
                case: 'UNKNOWN'
              })))
      }

      action_done.call(act_instance, err)
      return false
    }

    return true
  }

  function act_error (instance, err, actmeta, result, cb,
    duration, callargs, origargs, prior_ctxt, act_callpoint) {
    var call_cb = true
    actmeta = actmeta || {}

    if (!err.seneca) {
      err = internals.error(err, 'act_execute', _.extend(
        {},
        err.details,
        {
          message: (err.eraro && err.orig) ? err.orig.message : err.message,
          pattern: actmeta.pattern,
          fn: actmeta.func,
          cb: cb,
          instance: instance.toString()
        }))

      result[0] = err
    }

    // Special legacy case for seneca-perm
    else if (err.orig &&
      _.isString(err.orig.code) &&
      err.orig.code.indexOf('perm/') === 0) {
      err = err.orig
      result[0] = err
    }

    err.details = err.details || {}
    err.details.plugin = err.details.plugin || {}

    var entry = actlog(
      actmeta, prior_ctxt, callargs, origargs,
      {
        // kind is act as this log entry relates to an action
        kind: 'act',
        case: 'ERR',
        duration: duration
      })
    entry = errlog(err, entry)

    instance.log.error(entry)
    instance.emit('act-err', callargs, err)

    // when fatal$ is set, prefer to die instead
    if (so.errhandler && (!callargs || !callargs.fatal$)) {
      call_cb = !so.errhandler.call(instance, err)
    }

    return {
      call_cb: call_cb,
      err: err
    }
  }

  function callback_error (instance, err, actmeta, result, cb,
    duration, callargs, origargs, prior_ctxt, act_callpoint) {
    actmeta = actmeta || {}

    if (!err.seneca) {
      err = internals.error(err, 'act_callback', _.extend(
        {},
        err.details,
        {
          message: err.message,
          pattern: actmeta.pattern,
          fn: actmeta.func,
          cb: cb,
          instance: instance.toString()
        }))

      result[0] = err
    }

    err.details = err.details || {}
    err.details.plugin = err.details.plugin || {}

    instance.log.error(actlog(
      actmeta, prior_ctxt, callargs, origargs,
      {
        // kind is act as this log entry relates to an action
        kind: 'act',
        case: 'ERR',
        info: err.message,
        code: err.code,
        err: err,
        duration: duration
      }))

    instance.emit('act-err', callargs, err, result[1])

    if (so.errhandler) {
      so.errhandler.call(instance, err)
    }
  }

  // Check if actid has already been seen, and if action cache is active,
  // then provide cached result, if any. Return true in this case.
  function apply_actcache
  (instance, callargs, origargs, prior_ctxt, actcb, act_callpoint) {
    var actid = callargs.id$ || callargs.actid$

    if (actid != null && so.actcache.active) {
      var actdetails = private$.actcache.get(actid)

      if (actdetails) {
        var actmeta = actdetails.actmeta || {}
        private$.stats.act.cache++

        instance.log.debug(actlog(
          {}, prior_ctxt, callargs, origargs,
          { kind: 'act', case: 'CACHE' }))

        if (actcb) {
          setImmediate(function () {
            actcb.apply(instance, actdetails.result)
          })
        }

        return actmeta
      }
    }

    return false
  }

  // Resolve action stats object, creating if ncessary, and count a call.
  //
  //    * _pattern_     (string)    &rarr;  action pattern
  function act_stats_call (pattern) {
    var actstats = (private$.stats.actmap[pattern] =
      private$.stats.actmap[pattern] || {})

    private$.stats.act.calls++
    actstats.calls++

    return actstats
  }

  function act_make_delegate (instance, tx, callargs, actmeta, prior_ctxt) {
    var delegate_args = {
      plugin$: {
        name: actmeta.plugin_name,
        tag: actmeta.plugin_tag
      }
    }

    var delegate = instance.delegate(delegate_args)

    // special overrides
    if (tx) { delegate.fixedargs.tx$ = tx }

    // automate actid log insertion
    delegate.log = make_log(delegate, function act_delegate_log_modifier (data) {
      data.actid = callargs.meta$.id

      data.plugin_name = data.plugin_name || actmeta.plugin_name
      data.plugin_tag = data.plugin_tag || actmeta.plugin_tag
      data.pattern = data.pattern || actmeta.pattern
    })

    if (actmeta.priormeta) {
      delegate.prior = function (prior_args, prior_cb) {
        prior_args = _.clone(prior_args)

        var sub_prior_ctxt = _.clone(prior_ctxt)
        sub_prior_ctxt.chain = _.clone(prior_ctxt.chain)
        sub_prior_ctxt.chain.push(actmeta.id)
        sub_prior_ctxt.entry = false
        sub_prior_ctxt.depth++

        delete prior_args.id$
        delete prior_args.gate$
        delete prior_args.actid$
        delete prior_args.meta$
        delete prior_args.transport$

        if (callargs.default$) {
          prior_args.default$ = callargs.default$
        }

        prior_args.tx$ = tx

        do_act(delegate, actmeta.priormeta, sub_prior_ctxt, prior_args, prior_cb)
      }

      delegate.parent = function (prior_args, prior_cb) {
        delegate.log.warn({
          kind: 'notice',
          case: 'DEPRECATION',
          notice: Errors.deprecation.seneca_parent
        })
        delegate.prior(prior_args, prior_cb)
      }
    }
    else {
      delegate.prior = function (msg, done) {
        var out = callargs.default$ ? callargs.default$ : null
        return done.call(delegate, null, out)
      }
    }

    return delegate
  }


  // Validate action message contents, if validator function defined.
  //
  //    * _msg_     (object)    &rarr;  action arguments
  //    * _actmeta_  (object)    &rarr;  action meta data
  //    * _done_     (function)  &rarr;  callback function
  function validate_action_message () {
    var args = Norma('msg:o actmeta:o done:f', arguments)

    if (!_.isFunction(args.actmeta.validate)) {
      return args.done()
    }

    args.actmeta.validate(args.msg, function (err) {
      if (!err) {
        return args.done()
      }

      return args.done(
        internals.error(
          so.legacy.error_codes ? 'act_invalid_args' : 'act_invalid_msg',
          {
            pattern: args.actmeta.pattern,
            message: err.message,
            msg: Common.clean(args.msg)
          })
      )
    })
  }


  function api_fix () {
    var self = this

    var defargs = Common.parsePattern(self, arguments)

    var fix = self.delegate(defargs.pattern)

    fix.add = function () {
      var args = Common.parsePattern(fix, arguments, 'rest:.*', defargs.pattern)
      var addargs = [args.pattern].concat(args.rest)
      return self.add.apply(fix, addargs)
    }

    return fix
  }

  function api_delegate (fixedargs) {
    var self = this
    fixedargs = fixedargs || {}

    var delegate = Object.create(self)
    delegate.private$ = Object.create(self.private$)

    delegate.did = refnid()

    var strdesc
    delegate.toString = function () {
      if (strdesc) return strdesc
      var vfa = {}
      _.each(fixedargs, function (v, k) {
        if (~k.indexOf('$')) return
        vfa[k] = v
      })

      strdesc = self.toString() +
        (_.keys(vfa).length ? '/' + Jsonic.stringify(vfa) : '')

      return strdesc
    }

    delegate.fixedargs = (so.strict.fixedargs
      ? _.extend({}, fixedargs, self.fixedargs)
      : _.extend({}, self.fixedargs, fixedargs))

    delegate.delegate = function (further_fixedargs) {
      var args = _.extend({}, delegate.fixedargs, further_fixedargs || {})
      return self.delegate.call(this, args)
    }

    // Somewhere to put contextual data for this delegate.
    // For example, data for individual web requests.
    delegate.context = {}

    delegate.client = function () {
      return self.client.apply(this, arguments)
    }

    delegate.listen = function () {
      return self.listen.apply(this, arguments)
    }

    return delegate
  }

  function api_options (options, mark) {
    var self = this

    if (options != null) {
      self.log.debug({
        kind: 'options',
        case: 'SET',
        options: options,
        callpoint: callpoint()})
    }

    so = private$.exports.options = ((options == null)
      ? private$.optioner.get()
      : private$.optioner.set(options))

    if (so.legacy.logging) {
      if (options && options.log && _.isArray(options.log.map)) {
        for (var i = 0; i < options.log.map.length; ++i) {
          self.logroute(options.log.map[i])
        }
      }
    }

    return so
  }

  function api_start (errhandler) {
    var sd = this.delegate()
    var options = sd.options()
    options.zig = options.zig || {}

    function make_fn (self, origargs) {
      var args = Common.parsePattern(self, origargs, 'fn:f?')

      var actargs = _.extend(
        {},
        args.moreobjargs ? args.moreobjargs : {},
        args.objargs ? args.objargs : {},
        args.strargs ? Jsonic(args.strargs) : {}
     )

      var fn
      if (args.fn) {
        fn = function (data, done) {
          return args.fn.call(self, data, done)
        }
      }
      else {
        fn = function (data, done) {
          if (args.strargs) {
            var $ = data // eslint-disable-line
            _.each(actargs, function (v, k) {
              if (_.isString(v) && v.indexOf('$.') === 0) {
                actargs[k] = eval(v) // eslint-disable-line
              }
            })
          }

          self.act(actargs, done)
          return true
        }
        fn.nm = args.strargs
      }

      return fn
    }

    var dzig = Zig({
      timeout: options.zig.timeout || options.timeout,
      trace: options.zig.trace
    })

    dzig.start(function () {
      var self = this
      dzig.end(function () {
        if (errhandler) errhandler.apply(self, arguments)
      })
    })

    sd.end = function (cb) {
      var self = this
      dzig.end(function () {
        if (cb) return cb.apply(self, arguments)
        if (errhandler) return errhandler.apply(self, arguments)
      })
      return self
    }

    sd.wait = function () {
      dzig.wait(make_fn(this, arguments))
      return this
    }

    sd.step = function () {
      dzig.step(make_fn(this, arguments))
      return this
    }

    sd.run = function () {
      dzig.run(make_fn(this, arguments))
      return this
    }

    sd.if = function (cond) {
      dzig.if(cond)
      return this
    }

    sd.endif = function () {
      dzig.endif()
      return this
    }

    sd.fire = function () {
      dzig.step(make_fn(this, arguments))
      return this
    }

    return sd
  }

  function api_error (errhandler) {
    this.options({ errhandler: errhandler })
    return this
  }

  // Inspired by https://github.com/hapijs/hapi/blob/master/lib/plugin.js decorate
  function api_decorate () {
    var args = Norma('property:s value:.', arguments)

    // TODO: review; needs to be more universally applicable
    // also messages should not be embedded directly
    var property = args.property
    Assert(property[0] !== '_', 'property cannot start with _')
    Assert(private$.decorations[property] === undefined, 'seneca is already decorated with the property')
    Assert(root[property] === undefined, 'cannot override a core seneca property: ' + property)

    root[property] = private$.decorations[property] = args.value
  }

  // DEPRECATED
  // for use with async
  root.next_act = function () {
    var si = this || root
    var args = arrayify(arguments)

    si.log.warn({
      kind: 'notice',
      case: 'DEPRECATION',
      notice: Errors.deprecation.seneca_next_act
    })


    return function (next) {
      args.push(next)
      si.act.apply(si, args)
    }
  }

  root.gate = function () {
    return this.delegate({gate$: true})
  }


  root.ungate = function () {
    this.fixedargs.gate$ = false
    return this
  }


  // Add builtin actions.
  root.add({role: 'seneca', cmd: 'stats'}, action_seneca_stats)
  root.add({role: 'seneca', cmd: 'close'}, action_seneca_close)
  root.add({role: 'seneca', info: 'fatal'}, action_seneca_fatal)
  root.add({role: 'seneca', get: 'options'}, action_options_get)

  // Legacy builtin actions.
  // Remove in Seneca 4.x
  root.add({role: 'seneca', stats: true, deprecate$: true}, action_seneca_stats)
  root.add({role: 'options', cmd: 'get', deprecate$: true}, action_options_get)

  Print(root)

  // Define builtin actions.

  function action_seneca_fatal (args, done) {
    done()
  }

  function action_seneca_close (args, done) {
    this.emit('close')
    done()
  }

  function action_seneca_stats (args, done) {
    args = args || {}
    var stats

    if (args.pattern && private$.stats.actmap[args.pattern]) {
      stats = private$.stats.actmap[args.pattern]
      stats.time = private$.timestats.calculate(args.pattern)
    }
    else {
      stats = _.clone(private$.stats)
      stats.now = new Date()
      stats.uptime = stats.now - stats.start

      stats.now = new Date(stats.now).toISOString()
      stats.start = new Date(stats.start).toISOString()

      var summary =
      (args.summary == null) ||
        (/^false$/i.exec(args.summary) ? false : !!(args.summary))

      if (summary) {
        stats.actmap = void 0
      }
      else {
        _.each(private$.stats.actmap, function (a, p) {
          private$.stats.actmap[p].time = private$.timestats.calculate(p)
        })
      }
    }

    if (done) {
      done(null, stats)
    }
    return stats
  }

  root.stats = action_seneca_stats

  function action_options_get (args, done) {
    var options = private$.optioner.get()

    var base = args.base || null
    var root = base ? (options[base] || {}) : options
    var val = args.key ? root[args.key] : root

    done(null, Common.copydata(val))
  }

  _.each(so.internal.close_signals, function (active, signal) {
    if (active) {
      process.once(signal, handleClose)
    }
  })


  function make_log (instance, modifier) {
    var log = instance.log || function (data) {
      private$.logger(this, data)
    }

    log = prepare_log(instance, make_modified_log(log, modifier))

    make_log_levels(instance, log)

    return log
  }

  function make_log_levels (instance, log) {
    function log_level (level) {
      return function (data) {
        data.level = level
      }
    }

    log.debug = prepare_log(instance, make_modified_log(log, log_level('debug')))
    log.info = prepare_log(instance, make_modified_log(log, log_level('info')))
    log.warn = prepare_log(instance, make_modified_log(log, log_level('warn')))
    log.error = prepare_log(instance, make_modified_log(log, log_level('error')))
    log.fatal = prepare_log(instance, make_modified_log(log, log_level('fatal')))
  }

  function prepare_log (instance, log) {
    return function prepare_log_data () {
      var a0 = arguments[0]
      var data = _.isArray(a0) ? a0
            : _.isObject(a0) ? a0
            : arrayify(arguments)

      log.call(instance, data)
    }
  }

  function make_modified_log (log, modifier) {
    return function log_modifier (data) {
      modifier(data)
      log.call(this, data)
    }
  }

  function default_log_modifier (data) {
    data.level = null == data.level ? 'debug' : data.level
    data.seneca = null == data.seneca ? root.id : data.seneca
    data.when = null == data.when ? Date.now() : data.when
  }

  function load_logger (instance, log_plugin) {
    log_plugin = log_plugin ||
      require(so.legacy.logging ? 'seneca-legacy-logger' : './lib/logging')

    // TODO: check for preload
    return log_plugin.preload.call(instance).extend.logger
  }


  function action_queue_clear () {
    root.emit('ready')

    // DEPRECATED, removed in Seneca 3.0
    root.emit('pin')
    root.emit('after-pin')

    var ready = root.private$.ready_list.shift()
    if (ready) {
      ready()
    }

    if (root.private$.ge.isclear()) {
      while (0 < root.private$.ready_list.length) {
        root.private$.ready_list.shift()()
      }
    }
  }

  return root
}

// Declarations

// Private member variables of Seneca object.
function make_private () {
  return {
    stats: {
      start: Date.now(),
      act: {
        calls: 0,
        done: 0,
        fails: 0,
        cache: 0
      },
      actmap: {}
    }
  }
}

// Callpoint resolver. Indicates location in calling code.
function make_callpoint (active) {
  if (active) {
    return function () {
      return internals.error.callpoint(
        new Error(),
        ['/seneca/seneca.js', '/seneca/lib/', '/lodash.js'])
    }
  }

  return _.noop
}
