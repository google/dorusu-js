#!/usr/bin/env node
'use strict';

/**
 * nurpc/interop/interop_server implements the rpc servers interoperability
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
 * @module nurpc/interop/interop_server
 */

var _ = require('lodash');
var app = require('../lib/app');
var bunyan = require('bunyan');
var http2 = require('http2');
var insecureOptions = require('../test/util').insecureOptions;
var path = require('path');
var protobuf = require('../lib/protobuf');
var nurpc = require('../lib/nurpc');
var secureOptions = require('../test/util').secureOptions;
var server = require('../lib/server');

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
  request.on('data', function(msg) {
    response.end({});
  });
};

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
};

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
  })
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
      })
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
  var testpb = protobuf.loadProto(path.join(__dirname, 'test.proto'));
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
             nurpc.notFound);
  return a;
}


var version = '0.1.0'
/**
 * parseArgs parses the command line options/arguments when this file is run as
 * a script.
 */
var parseArgs = function parseArgs() {
  var parser = new ArgumentParser({
    version: version,
    addHelp:true,
    description: 'NuRPC Node.js Interopability Test Server.\n'
                 + 'Runs the Interoperability test server used to validate'
                 + ' RPCs implementations'
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
      help: 'When set, indicates that the server should be accessed'
            + ' securely using the example test credentials'
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
    s = server.createServer(opts);
  } else {
    s = server.raw.createServer(opts);
    _.merge(opts, insecureOptions);
  }
  s.listen(args.port);
};

if (require.main === module) {
  main();
}
