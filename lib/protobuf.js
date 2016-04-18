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

var _ = require('lodash');
var app = require('./app');

var ProtoBuf = require('protobufjs');

/**
 * dorusu/protobuf allows the creation of clients defined by protobuf IDL and
 * support for servers host protobuf defined services.
 *
 * @module dorusu/protobuf
 */

/**
 * Get a function that unmarshals a specific type of protobuf.
 * @param {function()} pbClass The constructor of the message type to unmarshal
 * @return {function(Buffer):cls} The unmarshaller function
 */
var buildUnmarshalFunc = function buildUnmarshalFunc(cls) {
  /**
   * Unmarshals a `Buffer` to a message object
   * @param {external:Buffer} b The buffer to deserialize
   * @returns {Object} The resulting object
   */
  return function unmarshal(b) {
    // Convert to a native object with binary fields as Buffers (first argument)
    // and longs as strings (second argument)
    return cls.decode(b).toRaw(false, true);
  };
};

/**
 * Get a function that marshals objects to `Buffer` by protobuf class.
 * @param {function()} PbClass The constructor of the message type to marshal
 * @return {function(pbClass):Buffer} the marshaller function
 */
var buildMarshalFunc = function buildMarshalFunc(PbClass) {
  /**
   * Marshals an object into a `Buffer`
   * @param {Object} arg The object to marshal
   * @return {external:Buffer} The marshalled object
   */
  return function marshal(arg) {
    return new Buffer(new PbClass(arg).encode().toBuffer());
  };
};

/**
 * Determines the full dotted name of a Protobuf.Reflect value
 * @param {ProtoBuf.Reflect.Namespace} value The value to get the name of
 * @return {string} The fully qualified name of the value
 */
var fullyDotted = function fullyDotted(value) {
  if (!value) {
    return '';
  }
  var name;
  while (value) {
    var suffix = value.name;
    if (value.className === 'Service.RPCMethod') {
      suffix = _.capitalize(suffix);
    }
    if (!name) {
      name = suffix;
    } else if (suffix !== '') {
      name = suffix + '.' + name;
    }
    value = value.parent;
  }
  return name;
};

/**
 * Converts a ProtoBuf service to an app.Service used to build clients.
 *
 * @param {ProtoBuf.Reflect.Service} protoSvc A protobufjs service descriptor
 * @return {Service} the corresponding client-side app.Service
 */
var clientSideSvcFor = function clientSideSvcFor(protoSvc) {
  var convertMethod = function convertMethod(m) {
    return app.Method(
      _.capitalize(m.name),
      buildMarshalFunc(m.resolvedRequestType.build()),
      buildUnmarshalFunc(m.resolvedResponseType.build()),
      m.requestStream);
  };
  var methods = _.map(protoSvc.children, convertMethod);
  return new app.Service(fullyDotted(protoSvc), methods);
};

/**
 * Converts a ProtoBuf service to an app.Service for use in server rpc apps.
 *
 * @param {ProtoBuf.Reflect.Service} protoSvc A protobufjs service descriptor
 * @return {Service} the corresponding server-side app.Service
 */
var serverSideSvcFor = function serverSideSvcFor(protoSvc) {
  var convertMethod = function convertMethod(m) {
    return app.Method(
      _.capitalize(m.name),
      buildMarshalFunc(m.resolvedResponseType.build()),
      buildUnmarshalFunc(m.resolvedRequestType.build()),
      m.requestStream);
  };
  var methods = _.map(protoSvc.children, convertMethod);
  return new app.Service(fullyDotted(protoSvc), methods);
};

/**
 * Generates a peer object from ProtoBuf.Reflect object.
 *
 * The result is an object graph, containing peers for their equivalent
 * in the original Protobuf.Reflect graph.  Services are treated specially,
 * they are converted into an object
 * {
 *   client: <client_service_peer>
 *   server_app: app.RpcApp(<server_service_peer>)
 * }
 *
 * where client_service_peer can be used to create rpc clients using
 * `client.buildClient`, and server_app is an app.RpcApp that can
 * serve requests.
 *
 * @param {ProtoBuf.Reflect.Namespace} value the Protobuf object to load
 * @return {Object<string, *>} the peer object.
 */
var loadObject = function loadObject(value) {
  var result = {};
  if (value.className === 'Namespace') {
    _.each(value.children, (child) => { result[child.name] = loadObject(child); });
    return result;
  } else if (value.className === 'Service') {
    return {
      Client: app.buildClient(clientSideSvcFor(value)),
      serverApp: new app.RpcApp(serverSideSvcFor(value))
    };
  } else if (value.className === 'Message' || value.className === 'Enum') {
    return value.build();
  } else {
    return value;
  }
};

/**
 * Load a proto peer object from a file.
 *
 * @description format is either `proto` or `json`, defaulting to `proto`
 *
 * @param {string} path path of the file to load
 * @param {string} [format='proto'] the format of the file
 * @returns {Object<string, *>} a proto peer object
 */
exports.loadProto = function loadProto(path, format) {
  if (!format) {
    format = 'proto';
  }
  var builder;
  switch(format) {
    case 'proto':
    builder = ProtoBuf.loadProtoFile(path);
    break;
    case 'json':
    builder = ProtoBuf.loadJsonFile(path);
    break;
    default:
    throw new Error('Unrecognized format "' + format + '"');
  }

  return loadObject(builder.ns);
};

/**
 * Load a proto peer object a proto file using standard node module resolution
 * order.
 *
 * id can omit the usual '.proto' extension, i.e, both
 * require('my_service.proto') and require('my_service')
 *
 * opt_require is usually only necessary when the 'id' is a local relative
 * path.  it should be unnecessary for protos in imported packages like
 * node_modules.
 *
 * @param {string} id the node 'id' of the proto file
 * @param {function} opt_require the require function of the module that
 *   loads the id.
 * @returns {Object<string, *>} a proto peer object
 */
exports.requireProto = function requireProto(id, opt_require) {
  var our_require = opt_require || require;
  if (!id.endsWith('.proto')) {
    id += '.proto';
  }
  return exports.loadProto(our_require.resolve(id));
};

exports.loadObject = loadObject;

/**
 * The nodejs `Buffer` class .
 * @external Buffer
 * @see https://nodejs.org/api/buffer.html
 */
