#!/usr/bin/env node
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
 * dorusu/interop/interop_server implements the rpc servers interoperability
 * server.
 *
 * It implements the service defined in test.proto, which is used to validate
 * rpc protocol implementations.
 *
 *
 * Example usage:
 *
 * Run the default insecure server
 * ```sh
 * $ example/interop_server.js
 * ```
 *
 * Run a secure server with info logging on port 8043
 * ```sh
 * $ HTTP2_LOG=info example/interop_server.js -p 8043 -s 2> >(bunyan)
 * ```
 *
 * Print full usage
 * ```sh
 * $ example/interop_server.js -h
 * ```
 *
 * @module dorusu/interop/interop_server
 */

var _ = require('lodash');
var app = require('../lib/app');
var bunyan = require('bunyan');
var http2 = require('http2');
var insecureOptions = require('../test/util').insecureOptions;
var dorusu = require('../lib');

var secureOptions = require('../example/certs').serverOptions;

var ArgumentParser = require('argparse').ArgumentParser;

/**
 * Create a buffer filled with `size` zeroes.
 *
 * @param {number} size The length of the buffer
 * @return {Buffer} buffer
 */
function zeroes(size) {
  var b = new Buffer(size);
  b.fill(0);
  return b;
}

/**
 * Implements the interop test service empty handler.
 *
 * Supports .../EmptyCall
 *
 * @param {Object} request the request stream
 * @param {Object} response the response stream
 */
function emptyCall(request, response) {
  request.on('data', function() {
    response.end({});
  });
}

/**
 * Implements the interop test service unary handler.
 *
 * Supports .../UnaryCall
 *
 * @param {Object} request the request stream
 * @param {Object} response the response stream
 */
function unaryCall(request, response) {
  request.on('data', function(msg) {
    var body = zeroes(msg.response_size);
    var type = msg.response_type;
    if (type === 'RANDOM') {
      type = ['COMPRESSABLE', 'UNCOMPRESSABLE'][Math.random() < 0.5 ? 0 : 1];
    }
    response.end({payload: {type: type, body: body}});
  });
}

/**
 * Implements the interop test service streaming input handler.
 *
 * Supports .../StreamingInputCall
 *
 * @param {Object} request the request stream
 * @param {Object} response the response stream
 */
var streamingInputCall = function streamingInputCall(request, response) {
  var totalSize = 0;
  request.on('data', function(msg) {
    totalSize += msg.payload.body.length;
  });
  request.on('end', function() {
    response.end({aggregated_payload_size: totalSize});
  });
};

/**
 * Implements the interop test service streaming output handler.
 *
 * Supports .../StreamingOutputCall
 *
 * @param {Object} request the request stream
 * @param {Object} response the response stream
 */
function streamingOutputCall(request, response) {
  request.on('data', function(msg){
    var type = msg.response_type;
    if (type === 'RANDOM') {
      type = ['COMPRESSABLE', 'COMPRESSABLE'][Math.random() < 0.5 ? 0 : 1];
    }
    _.each(msg.response_parameters, function(param) {
      response.write({
        payload: {
          body: zeroes(param.size),
          type: type
        }
      });
    });
  });
  request.on('end', function() {
    response.end();
  });
}

/**
 * Builds the `app.RpcApp` that provides the test service implementation
 *
 * - Creates the app with the service defined in test.proto
 * - Registers the handlers defined in this file
 *
 * @returns {app.RpcApp} providing the interop service implementation
 */
var buildApp = exports.buildApp = function buildApp() {
  var testpb = dorusu.pb.requireProto('./test', require);
  var a = new app.RpcApp(testpb.grpc.testing.TestService.server);
  a.register('/grpc.testing.TestService/EmptyCall', emptyCall);
  a.register('/grpc.testing.TestService/UnaryCall', unaryCall);
  a.register('/grpc.testing.TestService/StreamingInputCall',
             streamingInputCall);
  a.register('/grpc.testing.TestService/StreamingOutputCall',
             streamingOutputCall);
  a.register('/grpc.testing.TestService/FullDuplexCall',
             streamingOutputCall);
  a.register('/grpc.testing.TestService/HalfDuplexCall',
             dorusu.notFound);
  return a;
};


/**
 * parseArgs parses the command line options/arguments when this file is run as
 * a script.
 */
var parseArgs = function parseArgs() {
  var parser = new ArgumentParser({
    version: require('../package').version,
    addHelp:true,
    description: 'Dorusu Node.js Interopability Test Server.\n' +
                 'Runs the Interoperability test server used to validate' +
                 ' RPCs implementations'
  });
  parser.addArgument(
    [ '-p', '--port' ],
    {
      defaultValue: 50051,
      help: 'The Interop Server port',
      type: 'int'
    }
  );
  parser.addArgument(
    [ '-s', '--use_tls' ],
    {
      defaultValue: false,
      action: 'storeTrue',
      help: 'When set, indicates that the server should be accessed' +
            ' securely using the example test credentials'
    }
  );
  return parser.parseArgs();
};

/**
 * Provides a command line entry point when this file is run as a script.
 */
var main = function main() {
  var log = bunyan.createLogger({
    name: 'interop_server',
    stream: process.stdout,
    level: process.env.HTTP2_LOG || 'info',
    serializers: http2.serializers
  });
  var opts  =  {
    app: buildApp(),
    host: '0.0.0.0',
    log: log
  };
  var args = parseArgs();
  var s;
  if (args.use_tls) {
    _.merge(opts, secureOptions);
    s = dorusu.createServer(opts);
  } else {
    s = dorusu.raw.createServer(opts);
    _.merge(opts, insecureOptions);
  }
  s.listen(args.port);
};

if (require.main === module) {
  main();
}
