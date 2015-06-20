'use strict';

var _ = require('lodash');

exports.Service = Service;

// An Service contains its name and its service methods.
function Service(name, methods) {
  // allow use without new
  if (!(this instanceof Service)) {
    return new Service(name, methods);
  }

  this.name = name;
  this.methods = methods;
}

exports.Method = Method;

// An Method holds its name, a marshaller for marshalling responses and a
// unmarshaller for unmarshalling requests.
function Method(name, marshaller, unmarshaller) {
  // allow use without new
  if (!(this instanceof Method)) {
    return new Method(name, marshaller, unmarshaller);
  }

  this.name = name;
  this.marshaller = marshaller;
  this.unmarshaller = unmarshaller;
}

exports.RpcApp = RpcApp;

// An RpcApp contains a number of Services.
//
// Its provides methods for registering handlers for the services, and obtaining
// the handlers, marshallers and unmarshallers associate with registered routes.
function RpcApp() {
  this._unmarshallers = {};
  this._handlers = {};
  this._requiredRoutes = [];
  this._marshallers = {};
  this._services = {};
  var addService = this.addService.bind(this);
  _.each(arguments, function(svc) { addService(svc) });
}

// `addService` adds Services.
//
// Once added, `isComplete` will be false until all the services' methods have
// registered handlers that satisfy them.
RpcApp.prototype.addService = function addService(svc) {
  if (this._services[svc.name]) {
    console.error('A service with name', svc.name, 'is already registered');
    throw new Error('service is already registered');
  }
  var that = this;
  this._services[svc.name] = svc;
  _.forEach(svc.methods, function(m) {
    var route = '/' + svc.name + '/' + m.name;
    if (that._requiredRoutes.indexOf(route) != -1) {
      console.error('A route with name', route, 'is already present');
      throw new Error('route is already registered');
    }
    that._requiredRoutes.push(route);
    that._unmarshallers[route] = m.unmarshaller;
    that._marshallers[route] = m.marshaller;
  });
};

/**
 * `register` adds a handler to process a route.
 *
 * registration must occur after the service which the handler helps to implemnt
 * has been added to the app.  Multiple registrations of the same route are not
 * allowed.
 *
 * @param {string} route the route to be handled by handler
 * @param {function} handler a function(request, response) to handle the request
 */
RpcApp.prototype.register = function register(route, handler) {
  if (this._handlers[route]) {
    console.error('route', route, 'is already registered');
    throw new Error('route is already registered');
  }
  if (this._requiredRoutes.indexOf(route) == -1) {
    console.error('route', route, 'is not required');
    throw new Error('route is not required');
  }
  this._handlers[route] = handler;
};

/**
 * isComplete indicates if all the required handlers have been registered.
 */
RpcApp.prototype.isComplete = function isComplete() {
  return this.missingRoutes().length === 0;
};

/**
 * hasRoute indicates if this app handles a particular route
 */
RpcApp.prototype.hasRoute = function hasRoute(route) {
  return !!this._handlers[route];
};

/**
 * missingRoutes indicates the routes that have yet to any handlers registered.
 */
RpcApp.prototype.missingRoutes = function missingRoutes() {
  return _.filter(
    this._requiredRoutes,
    function(r) { return !this._handlers[r] },
    this);
};

/**
 * dispatcher returns a handler function suitable for passing as request
 * listener to `RpcServer.createServer` that dispatches between the registered
 * server functions.
 */
RpcApp.prototype.dispatcher = function dispatcher() {
  return makeDispatcher(this._handlers);
};

/**
 * marshaller obtains the response marshaller for `route`.
 */
RpcApp.prototype.marshaller = function(route) {
  return this._marshallers[route];
};

/**
 * unmarshaller obtains the request unmarshaller for `route`.
 */
RpcApp.prototype.unmarshaller = function(route) {
  return this._unmarshallers[route];
};

/**
 * handler obtains the registered handler for route.
 */
RpcApp.prototype.handler = function(route) {
  return this._handlers[route];
};
