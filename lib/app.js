/*
 *
 * Copyright 2015, Google Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 */
'use strict';

/**
 * nurpc/app organizes rpc handlers.
 *
 * @module nurpc/app
 */

var _ = require('lodash');
var nurpc = require('./nurpc');


/**
 * A method describes an rpc that is to be available as part of a {Service}.
 *
 * It consists of its name and the marshaller and unmarshaller that will be used
 * to unmarshal the request and marshal the response on servers.
 *
 * On a client, the request is marshalled, and the response is unmarshalled.
 *
 * @param {string} name the name of the method
 * @param {function} [marshaller] marshals the response|request to a `Buffer`
 * @param {function} [unmarshaller] unmarshals the request|response from a
 *                                  `Buffer`
 * @param {function} [clientStreams] indicates that the client can send more
 *                                   than message as part of the rpc
 * @constructor
 */
function Method(name, marshaller, unmarshaller, clientStreams) {
  // allow use without new
  if (!(this instanceof Method)) {
    return new Method(name, marshaller, unmarshaller, clientStreams);
  }

  this.name = name;
  this.marshaller = marshaller;
  this.unmarshaller = unmarshaller;
  this.clientStreams = !!clientStreams;
}


/**
 * A Service describes a logical grouping of rpc methods.
 *
 * It consists of name, the methods that make up the service.
 * @param {string} name the name of the service
 * @param {Method[]} methods the methods that make up the service
 * @constructor
 */
function Service(name, methods) {
  // allow use without new
  if (!(this instanceof Service)) {
    return new Service(name, methods);
  }

  this.name = name;
  this.methods = methods;
}


/**
 * RpcApp contains a number of `Services`, allowing them to deployed together on
 * a server.
 *
 * Its provides methods for registering handlers for the services, and obtaining
 * the handlers, marshallers and unmarshallers associate with registered routes.
 *
 * @param {Services} services can be included when the RpcApp is constructed.
 * @constructor
 */
function RpcApp() {
  this._unmarshallers = {};
  this._handlers = {};
  this._requiredRoutes = [];
  this._marshallers = {};
  this._services = {};
  _.each(arguments, this.addService.bind(this));
}

/**
 * Adds a service description.
 *
 * Once added, `isComplete` will be false until all handlers registered for
 * all the services' methods.
 *
 * @param {Service} svc a Service
 */
RpcApp.prototype.addService = function addService(svc) {
  if (this._services[svc.name]) {
    console.error('A service with name', svc.name, 'is already registered');
    throw new Error('service is already registered');
  }
  this._services[svc.name] = svc;
  _.forEach(svc.methods, (m) => {
    var route = '/' + svc.name + '/' + m.name;
    if (this._requiredRoutes.indexOf(route) !== -1) {
      console.error('A route with name', route, 'is already present');
      throw new Error('route is already registered');
    }
    this._requiredRoutes.push(route);
    this._unmarshallers[route] = m.unmarshaller;
    this._marshallers[route] = m.marshaller;
  });
};

/**
 * Adds a handler to process a route.
 *
 * registration must occur after the service which the handler helps to implemnt
 * has been added to the app.  Multiple registrations of the same route are not
 * allowed.
 *
 * TODO: add a registerObject(...) function to address the following feedback:
 *
 * Since the set of possible routes is predefined by the proto and setting an
 * arbitrarily named route results in an error, I would guess handlers may
 * frequently be attached all at the same time at a per-service or per-app
 * granularity (as is done in the math example).  To support this style, maybe
 * the api could have a different function which takes all of the handlers for a
 * service simultaneously. potentially as an object of the form
 *
 * @param {string} route the route to be handled by handler
 * @param {function} handler a function(request, response) to handle the request
 */
RpcApp.prototype.register = function register(route, handler) {
  if (this._handlers[route]) {
    console.error('route', route, 'is already registered');
    throw new Error('route is already registered');
  }
  if (this._requiredRoutes.indexOf(route) === -1) {
    console.error('route', route, 'is not required');
    throw new Error('route is not required');
  }
  this._handlers[route] = handler;
};

/**
 * isComplete indicates if all the required handlers have been registered.
 *
 * @return {boolean}
 */
RpcApp.prototype.isComplete = function isComplete() {
  return this.missingRoutes().length === 0;
};

/**
 * hasRoute indicates if this app handles a particular route
 *
 * @returns {boolean}
 */
RpcApp.prototype.hasRoute = function hasRoute(route) {
  return !!this._handlers[route];
};

/**
 * missingRoutes indicates the routes that have yet to any handlers registered.
 *
 * @returns {string[]}
 */
RpcApp.prototype.missingRoutes = function missingRoutes() {
  return _.filter(this._requiredRoutes, (r) => !this._handlers[r]);
};

/**
 * Obtains a handler function suitable for passing as request listener to
 * `RpcServer.createServer` that dispatches between the registered server
 * functions.
 *
 * @param {function} opt_fallback the default handler used for requests without
 *                                 a matching route
 * @returns {function} a rpc handler function
 */
RpcApp.prototype.dispatcher = function dispatcher(opt_fallback) {
  return nurpc.makeDispatcher(this._handlers, opt_fallback);
};

/**
 * marshaller obtains the response marshaller for `route`.
 *
 * @returns {function} the marshal function for route
 */
RpcApp.prototype.marshaller = function(route) {
  return this._marshallers[route];
};

/**
 * unmarshaller obtains the request unmarshaller for `route`.
 *
 * @returns {function} the unmarshal function for route
 */
RpcApp.prototype.unmarshaller = function(route) {
  return this._unmarshallers[route];
};

/**
 * handler obtains the registered handler for route.
 *
 * @returns {function} the handle function for route
 */
RpcApp.prototype.handler = function(route) {
  return this._handlers[route];
};

exports.Method = Method;
exports.Service = Service;
exports.RpcApp = RpcApp;
