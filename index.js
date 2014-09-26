'use strict';
(function() {
    var _ = require('lodash'),
        controllerFiles,
        controllers = {},
        emitter = require('primus-emitter'),
        fs = require('fs'),
        http = require('http'),
        multiplex = require('primus-multiplex'),
        path = require('path'),
        pkg = require('./package.json'),
        primusMapping = require('./primusMapping'),
        scriptInjection = [
            '<script src="/static/js/primus.min.js" type="text/javascript"></script>',
            '<script type="text/javascript">',
            '(function (root) {',
            '   if (jwtToken) {',
            '       var primus = Primus.connect("ws://{{HOST}}:{{PORT}}/?token=" + jwtToken);',
            '       root.Controller = primus.resource("{{CONTROLLER}}");',
            '   }',
            '})(this);',
            '</script>'
        ].join('\n'),
        wrench = require('wrench'),
        UglifyJS = require('uglify-js'),
        appDir = path.dirname(require.main.filename);

    var config = {
        primus: null,
        server: null,
        appName: null,
        cacheSettings: {
                privacy: 'public',
                expiresIn: 3.6e6
            },
        controllerPath: './Controllers',
        staticPath: './Static',
        bindStaticFiles: true,
        indexController: 'index',
        customSparkParams: {},
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

    exports.register = function(plugin, options, next) {
        Object.keys(options).forEach(function(k) {
            if (config[k] !== undefined) {
                config[k] = options[k];
            } else {
                console.log(
                    'The option passed to hapi-welding of %s is invalid and thus ignored',
                    k);
            }
        });

        config.primus.resources = {};

        if (!config.primus.channel) {
            // add multiplex to Primus
            config.primus.use('multiplex', multiplex);
            config.primus.use('emitter', emitter);
            config.primus.use('resource', primusMapping);

            controllerFiles = wrench.readdirSyncRecursive(path.resolve(appDir,
                config.controllerPath));

            //set primus linkage for the client
            scriptInjection = scriptInjection.replace('{{HOST}}', config.server.info
                .host);
            scriptInjection = scriptInjection.replace('{{PORT}}', config.server.info
                .port);

        }

        // Generate uglified primus lib
        var primusDir  = path.join(path.resolve(appDir, config.staticPath), 'js'),
            primusFile = path.join(primusDir, 'primus.js');
        fs.exists(primusDir, function(exists) {
            if (!exists) {
                fs.mkdirSync(primusDir);
            }
            config.primus.save(primusFile, function saved(err) {
                if (err) {
                    throw err;
                }
                fs.writeFile(primusFile.replace('.js', '.min.js'), 
                        UglifyJS.minify(primusFile).code, function(err) {
                    if (err) {
                        throw err;
                    }
                });
            });
        });

        // Route to the static files
        if (config.bindStaticFiles) {
            plugin.route({
                method: 'GET',
                path: '/static/{path*}',
                config: {
                    handler: {
                        directory: {
                            path: path.resolve(appDir, config.staticPath),
                            listing: false,
                            index: true
                        }
                    },
                    cache: config.cacheSettings
                }
            });
        }

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
                log('[primus] Responding with', JSON.stringify(request.session)
                    .substr(0, 100) + ' ... }');
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
            if (file.indexOf(path.sep) === -1) {

                controllers[file] = {};

                // Sub-controllers
            } else {
                var cp = file.split(path.sep);

                // allow for private files
                if (cp[1].substring(0, 1) !== '_') {
                    controllers[cp[0]][cp[1]] = require(path.resolve(appDir, config
                        .controllerPath, file));
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
                    var Controller = controllers[controller][subController],
                        subControllerRoute = subController;
                    //tempCont = new Controller();

                    config.primus.resource(controller + subController,
                        Controller.prototype);

                    //If the requested view was not avaliable...
                    if (!fs.existsSync(path.resolve(options.server.settings.views
                        .path, controller, Controller.prototype.view.trim() +
                        '.html'))) {
                        Controller.prototype.view = 'index';
                        console.log(
                            'Invalid view "%s" requested for the %s controller, defaulting to "index"',
                            Controller.prototype.view, controller + '/' +
                            subController);
                    }

                    //If controller overrides its name for routing
                    if (Controller.prototype.controllerRouting) {
                        subControllerRoute = Controller.prototype.controllerRouting;
                    }

                    // Add the route
                    plugin.route({
                        method: 'GET',
                        path: '/' + controller + '/' + subControllerRoute +
                            Controller.prototype.routing,
                        config: {
                            auth: Controller.prototype.security,
                            handler: function(req, reply) {
                                var Controller = controllers[controller][
                                    subController
                                ];

                                new Controller(req, function(instance) {
                                    var user = req.auth && req.auth.credentials
                                        ? req.auth.credentials
                                        : {},
                                        viewOptions = {};
                                    if (instance.layout) {
                                        viewOptions = {
                                            layout: instance.layout
                                        };
                                    }

                                    // If we are redirecting
                                    if (instance.redirect) {
                                        reply.redirect(instance.redirect);
                                    } else {
                                        // Render the view with the custom greeting
                                        reply.view(controller + '/' +
                                            instance.view, _.merge({
                                                APP_NAME: config.appName,
                                                PRIMUS_SCRIPTS: scriptInjection
                                                    .replace(
                                                        '{{CONTROLLER}}',
                                                        controller +
                                                        subController),
                                                PRIMUS_JS: '/static/js/primus.min.js',
                                                user: {
                                                    isAuthenticated: req.auth.isAuthenticated
                                                }
                                            }, instance.viewProps, user),
                                            viewOptions);
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
    };

    exports.register.attributes = {
      pkg: require('./package.json')
    };
})();