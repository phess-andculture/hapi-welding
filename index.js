'use strict';

var http = require('http'),
    wrench = require('wrench'),
    path = require('path'),
    _ = require('lodash'),
    fs = require('fs'),
    multiplex = require('primus-multiplex'),
    emitter = require('primus-emitter'),
    primusMapping = require('./primusMapping'),
    appDir = path.dirname(require.main.filename),
    controllerFiles,
    pkg = require('./package.json'),
    scriptInjection = [
        '<script src="/static/primus.js" type="text/javascript"></script>',
        '<script type="text/javascript">',
        '(function (root) {',
        '   var primus = Primus.connect("ws://{{HOST}}:{{PORT}}");',
        '   root.Controller = primus.resource("{{CONTROLLER}}");',
        '})(this);',
        '</script>'
    ].join('\n'),
    controllers = {};

var config = {
    primus: null,
    server: null,
    appName: null,
    controllerPath: './Controllers',
    staticPath: './Static',
    indexController: 'index',
    //Enable/disable logging
    debug: false,
    //Something with a log method
    logger: console,
    //Path to mount the internal request at
    //shouldn't need to be changed unless there's a conflict
    routePath: '/hapi-welding/write-session'
};

var log = function() {
    if (config.debug) {
        config.logger.log.apply(config.logger, arguments);
    }
};

var primusPlugin = function(hapiServer) {
    return {
        server: function(primus) {
            primus.Spark.prototype.getSession = function(done) {
                var self = this;

                //Memoize for this spark
                if (this.session) {
                    log('Returning memoized session');
                    return done(null, this.session);
                }

                //Construct fake request to pass to pass to hapi
                var socket = {};
                var req = new http.IncomingMessage(socket);
                req.url = config.routePath;
                req.method = 'GET';
                req.headers = this.headers;

                //Construct fake response
                var res = new http.ServerResponse(req);

                //Extend response to be called from HAPI to write session
                //back here to the spark
                res._writeSession = function(session) {
                    log('[spark]', 'Received session');
                    self.session = session;
                    done(null, session);
                };

                //Emit the request from the hapi http server
                log('[spark]', 'Emitting request');
                hapiServer.listener.emit('request', req, res);
            };
        }
    };
};

module.exports = {
    name: 'hapi_welding',
    version: pkg.version,
    register: function(plugin, options, next) {
        Object.keys(options).forEach(function(k) {
            if (config[k] !== undefined) {
                config[k] = options[k];
            } else {
                console.log('The option passed to hapi-welding of %s is invalid and thus ignored', k);
            }
        });

        config.primus.resources = {};

        if (!config.primus.channel) {
            // add multiplex to Primus
            config.primus.use('multiplex', multiplex);
            config.primus.use('emitter', emitter);
            config.primus.use('resource', primusMapping);

            controllerFiles = wrench.readdirSyncRecursive(path.resolve(appDir, config.controllerPath));

            //set primus linkage for the client
            scriptInjection = scriptInjection.replace('{{HOST}}', config.server.info.host);
            scriptInjection = scriptInjection.replace('{{PORT}}', config.server.info.port);

        }

        // Route to the primus lib
        plugin.route({
            method: 'GET',
            path: '/static/primus.js',
            handler: function(req, reply) {
                reply(config.primus.library())
                    .type('application/javascript');
            }
        });

        // Route to the static files
        plugin.route({
            method: 'GET',
            path: '/static/{path*}',
            handler: {
                directory: {
                    path: path.resolve(appDir, config.staticPath),
                    listing: false,
                    index: true
                }
            }
        });

        // Add the index route
        plugin.route({
            method: 'GET',
            path: '/',
            config: {
                handler: function(req, reply) {
                    reply().redirect(config.indexController);
                }
            }
        });

        plugin.route({
            method: 'GET',
            path: config.routePath,
            config: {},
            handler: function(request) {
                log('[primus] Got request for session');
                log('[primus] Responding with', JSON.stringify(request.session).substr(0, 100) + ' ... }');
                request.raw.res._writeSession(request.session);
            }
        });

        options.primus.use('hapi_welding', primusPlugin(options.server));

        // init all the controllers into a map so that its in-memory
        for (var i = 0; i < controllerFiles.length; i++) {
            var file = controllerFiles[i].replace('.js', '');

            // because sometimes OS X sucks
            if (file.indexOf('DS_Store') !== -1) {
                continue;
            }

            // Root controllers
            if (file.indexOf('/') === -1) {

                controllers[file] = {};

                // Sub-controllers
            } else {
                var cp = file.split('/');

                // allow for private files
                if (cp[1].substring(0, 1) !== '_') {
                    controllers[cp[0]][cp[1]] = require(path.resolve(appDir, config.controllerPath, file));
                }
            }
        }

        for (var controller in controllers) {

            (function(controller) {
                // redirect to the index subroute
                plugin.route({
                    method: 'GET',
                    path: '/' + controller,
                    config: {
                        handler: function(req, reply) {
                            reply().redirect('/' + controller + '/index');
                        }
                    }
                });
            })(controller);

            for (var subController in controllers[controller]) {

                // ignore private files
                if (subController.substring(0, 1) === '_') {
                    continue;
                }

                (function(controller, subController) {
                    var Controller = controllers[controller][subController];
                    //tempCont = new Controller();

                    config.primus.resource(controller + subController, Controller.prototype);

                    //If the requested view was not avaliable...
                    if(!fs.existsSync(path.resolve(options.server.settings.views.path, controller, Controller.prototype.view.trim() + '.html'))) {
                        Controller.prototype.view = 'index';
                        console.log('Invalid view "%s" requested for the %s controller, defaulting to "index"', Controller.prototype.view, controller + '/' + subController);
                    }

                    // Add the route
                    plugin.route({
                        method: 'GET',
                        path: '/' + controller + '/' + subController + Controller.prototype.routing,
                        config: {
                            handler: function(req, reply) {
                                var Controller = controllers[controller][subController];

                                new Controller({
                                    params: [req],
                                    callback: function() {
                                        var user = {};

                                        // Render the view with the custom greeting
                                        reply.view(controller + '/' + this.view, _.merge({
                                            APP_NAME: config.appName,
                                            SCRIPTS: scriptInjection.replace('{{CONTROLLER}}', controller + subController),
                                            PRIMUS_JS: '/static/primus.js',
                                            user: {
                                                isAuthenticated: true
                                            }
                                        }, this.viewProps, user));
                                    }
                                });

                            }
                        }
                    });
                })(controller, subController);
            }
        }

        // 404 routes? yea we got that!
        plugin.route({
            method: '*',
            path: '/{p*}',
            handler: function(request, reply) {
                reply.view('404', {
                    APP_NAME: config.appName,
                    pageTitle: 'Unknown',
                }).code(404);
            }
        });

        next();
    }
};
