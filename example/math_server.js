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
 * dorusu/example/math_server is an server implementing the math.Math service.
 *
 * The math.Math service is defined in math.proto.
 *
 * Example usage:
 *
 * Run the default insecure server
 * ```sh
 * $ example/math_server.js
 * ```
 *
 * Run a secure server with info logging on port 8043
 * ```sh
 * $ HTTP2_LOG=info example/math_server.js -p 8043 -s 2> >(bunyan)
 * ```
 *
 * Print full usage
 * ```sh
 * $ example/math_server.js -h
 * ```
 *
 * @module dorusu/example/math_server
 */

var _ = require('lodash');
var bunyan = require('bunyan');
var http2 = require('http2');
var insecureOptions = require('../test/util').insecureOptions;
var dorusu = require('../lib');
var secureOptions = require('../test/util').secureOptions;

var ArgumentParser = require('argparse').ArgumentParser;

/**
 * Implements math server division.
 *
 * Supports the /Math/DivMany and /Math/Div handlers
 * (Div is just DivMany with only one stream element). For each
 * DivArgs parameter, responds with a DivReply with the results of the division
 *
 * @param {Object} request the request stream
 * @param {Object} response the response stream
 */
function mathDiv(request, response) {
  request.on('data', function(msg) {
    if (+msg.divisor === 0) {
      response.rpcMessage = 'cannot divide by zero';
      response.rpcCode = dorusu.rpcCode('INVALID_ARGUMENT');
      response.end();
    } else {
      response.write({
        quotient: msg.dividend / msg.divisor,
        remainder: msg.dividend % msg.divisor
      });
    }
  });
  request.on('end', function() {
    response.end();
  });
  request.on('error', function() {
    response.end();
  });
}

/**
 * Implements math server summation.
 *
 * Supports the /Math/Sum handler. `request` is a stream `Num`s, the response is
 * written with their sum once the stream ends.
 *
 * @param {Object} request the request stream
 * @param {Object} response the response stream
 */
function mathSum(request, response) {
  // Here, call is a standard readable Node object Stream
  var sum = 0;
  request.on('data', function(data) {
    sum += (+data.num);
  });
  request.on('end', function() {
    response.end({num: sum});
  });
}

/**
 * Implements math server fibonacci.
 *
 * Supports the /Math/Fib handler. `request` is a `Num`, the response is
 * stream consisting of fibonnaci sequence up to the value in the request.
 *
 * @param {Object} request the request stream
 * @param {Object} response the response stream
 */
function mathFib(request, response) {
  var previous = 0, current = 1;
  request.on('data', function(msg) {
    for (var i = 0; i < msg.limit; i++) {
      response.write({num: current});
      var tmp = current;
      current += previous;
      previous = tmp;
    }
    response.end();
  });
}

/**
 * parseArgs parses the command line options/arguments when this file is run as
 * a script.
 */
var parseArgs = function parseArgs() {
  var parser = new ArgumentParser({
    version: require('../package').version,
    addHelp:true,
    description: 'Dorusu Node.js Math Server example.\n' +
                 'Runs an example Math Server and handles sample' +
                 ' RPCs.'
  });
  parser.addArgument(
    [ '-p', '--port' ],
    {
      defaultValue: 50051,
      help: 'The Math Server port',
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
 * Builds the `app.RpcApp` that provides the math service implementation
 *
 * - Creates the app with the service defined in math.proto
 * - Registers the handlers as handlers
 *
 * @returns {app.RpcApp} providing the math service implementation
 */
var buildApp = exports.buildApp = function buildApp() {
  var mathSvc = dorusu.pb.requireProto('./math', require).math.Math;
  var a = mathSvc.serverApp;
  a.register('/math.Math/DivMany', mathDiv);
  a.register('/math.Math/Div', mathDiv);
  a.register('/math.Math/Fib', mathFib);
  a.register('/math.Math/Sum', mathSum);
  return a;
};

/**
 * Provides a command line entry point when this file is run as a script.
 */
var main = function main() {
  var log = bunyan.createLogger({
    name: 'math_server',
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
