#!/usr/bin/env node
'use strict';

/**
 * nurpc/interop/interop_client is the client for the grpc.testing.TestService
 *
 * It implements the service defined in test.proto, which is used to validate
 * rpc protocol implementations.
 *
 * Example usage:
 *
 * Run all tests the insecure interop server at the default local port.
 * ```sh
 * $ interop_client.js
 * ```
 *
 * Run all test on secure server with info logging
 * ```sh
 * $ HTTP2_LOG=info interop_client.js -p 8443 -h my.domain.io -s 2> \
 *     >(bunyan)
 * ```
 *
 * Print full usage for description of other flags and options
 * ```sh
 * $ interop_client.js -h
 * ```
 *
 * @module nurpc/interop/interop_client
 */

var _ = require('lodash');
var async = require('async');
var buildClient = require('../lib/client').buildClient;
var bunyan = require('bunyan');
var expect = require('chai').expect;
var http2 = require('http2');
var insecureOptions = require('../test/util').insecureOptions;
var path = require('path');
var protobuf = require('../lib/protobuf');
var nurpc = require('../lib/nurpc');
var server = require('../lib/server');
var secureOptions = require('../test/util').secureClientOptions;

var ArgumentParser = require('argparse').ArgumentParser;
var Readable = require('stream').Readable;
var PassThrough = require('stream').PassThrough;

// Setup functions to use the default (noop) logger; main() resets this.
var log = nurpc.noopLogger;

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

exports.emptyUnary = function emptyUnary(client, next) {
  var done = next || _.noop;
  var req = {};
  client.emptyCall(req, function(response) {
    response.on('end', function() {
      done(null);
    });
    response.on('data', function(msg) {
      expect(msg).to.eql({});
      log.info('Verified: ok emptyCall(', req, ') is', msg);
    });
  });
};

exports.largeUnary = function largeUnary(client, next) {
  var done = next || _.noop;
  var req = {
    response_type: 'COMPRESSABLE',
    response_size: 314159,
    payload: {
      body: zeroes(271828)
    }
  };
  client.unaryCall(req, function(response) {
    response.on('end', function() {
      done();
    });
    response.on('data', function(msg) {
      expect(msg.payload.type).to.eql('COMPRESSABLE');
      expect(msg.payload.body.length).to.eql(314159);
      log.info('Verified: largeUnary(', req, ') is', msg);
    });
  });
};

exports.clientStreaming = function clientStreaming(client, next) {
  var done = next || _.noop;
  var payloadSizes = [27182, 8, 1828, 45904];
  var src = new Readable({objectMode: true});
  for (var i = 0; i < payloadSizes.length; i++) {
    src.push({payload: {body: zeroes(payloadSizes[i])}});
  }
  src.push(null);
  client.streamingInputCall(src, function(response) {
    response.on('end', function() {
      log.info('Verified: ok clientStreaming sent 74922 bytes');
      done();
    });
    response.on('data', function(msg) {
      expect(msg.aggregated_payload_size).to.eql(74922);
    });
  });
};

exports.serverStreaming = function serverStreaming(client, next) {
  var done = next || _.noop;
  var req = {
    response_type: 'COMPRESSABLE',
    response_parameters: [
      {size: 31415},
      {size: 9},
      {size: 2653},
      {size: 58979}
    ]
  };
  client.streamingOutputCall(req, function(response) {
    var index = 0;
    response.on('end', function() {
      log.info('Verified: streamingStreaming received', index, 'msgs');
      done();
    });
    response.on('data', function(msg) {
      expect(msg.payload.type).to.eql('COMPRESSABLE');
      expect(msg.payload.body.lengh,
             req.response_parameters[index].size);
      index += 1;
    });
  });
};

exports.pingPong = function pingPong(client, next) {
  var done = next || _.noop;
  var payloadSizes = [27182, 8, 1828, 45904];
  var responseSizes = [31415, 9, 2653, 58979];

  var src = new PassThrough({objectMode: true});
  var index = 0;
  var nextPing = function nextPing() {
    if (index === 4) {
      log.info('pingPong: ending after', index, 'pings');
      src.end();
    } else {
      log.info('pingPong: writing index:', index);
      src.write({
        response_type: 'COMPRESSABLE',
        response_parameters: [
          {size: responseSizes[index]}
        ],
        payload: {body: zeroes(payloadSizes[index])}
      });
    }
  }
  nextPing();  // start with a ping
  client.fullDuplexCall(src, function(response) {
    response.on('end', function() {
      log.info('Verified: pingPong sent/received', index, 'msgs');
      done();
    });
    response.on('data', function(msg) {
      log.info('pingPong: receiving index:', index);
      expect(msg.payload.type).to.eql('COMPRESSABLE');
      expect(msg.payload.body.lengh, responseSizes[index]);
      index += 1;
      nextPing();
    });
  });
};

exports.emptyStream = function emptyStream(client, next) {
  var done = next || _.noop;
  var src = Readable({objectMode:true});
  src.push(null);  // Do not send any messages;
  client.fullDuplexCall(src, function(response) {
    response.on('end', function() {
      log.info('Verified: empty stream sent/received');
      done();
    });
    response.on('data', function(msg) {
      expect(true).to.be(false); // should not be called
    });
  });
};

exports.runInteropTest = function runInteropTest(client, testCase, next) {
  var done = next || _.noop;
  if (!_.has(exports.knownTests, testCase)) {
    done(new Error('Unknown test case:' + testCase))
    return;
  };
  knownTests[testCase](client, done);
};

exports.allTests = function allTests(client, next) {
  var done = next || _.noop;
  var tasks = [];
  _.forEach(exports.knownTests, function(f, name) {
    if (name !== 'all') {
      tasks.push(f.bind(null, client));
    }
  });
  async.series(tasks, done);
};

/**
 * The interop tests that this file implements.
 */
exports.knownTests = {
  all: exports.allTests,
  large_unary: exports.largeUnary,
  empty_unary: exports.emptyUnary,
  client_streaming: exports.clientStreaming,
  server_streaming: exports.serverStreaming,
  ping_pong: exports.pingPong,
  empty_stream: exports.emptyStream
};
var knownTests = exports.knownTests;

var version = '0.1.0'
/**
 * parseArgs parses the command line options/arguments when this file is run as
 * a script.
 */
var parseArgs = function parseArgs() {
  var parser = new ArgumentParser({
    version: version,
    addHelp:true,
    description: 'NuRPC Node.js Interoperability Client.\n'
                 + 'It accesses an RPC Interoperability Server and performs'
                 + ' test RPCs that demonstrate conformance with the rpc'
                 + ' protocol specification.'
  });
  parser.addArgument(
    [ '-a', '--server_host' ],
    {
      help: 'The Interop Server hostname',
      defaultValue: 'localhost'
    }
  );
  parser.addArgument(
    [ '-p', '--server_port' ],
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
  parser.addArgument(
    [ '-c', '--use_test_ca' ],
    {
      defaultValue: true,
      action: 'storeTrue',
      help: 'When set, TLS connections use the test CA certificate'
    }
  );
  parser.addArgument(
    [ '-t', '--test_case' ],
    {
      choices: _.keys(knownTests),
      defaultValue: 'all',
      help: 'Specifies the name of the interop test to be run'
    }
  );
  parser.addArgument(
    [ '-o', '--oauth_scope' ],
    {
      defaultValue: '',
      help: 'The scope to use for oauth tokens'
    }
  );
  parser.addArgument(
    [ '-e', '--default_service_email_address' ],
    {
      defaultValue: '',
      help: 'Email address of the default service account'
    }
  );
  parser.addArgument(
    [ '-x', '--server_host_override' ],
    {
      defaultValue: 'foo.test.google.fr',
      help: 'Override hostname via a HTTP Header'
    }
  );
  return parser.parseArgs();
};

/**
 * Provides the command line entry point when this file is run as a script.
 */
var main = function main() {
  log = bunyan.createLogger({
    name: 'interop_client',
    stream: process.stdout,
    level: process.env.HTTP2_LOG || 'info',
    serializers: http2.serializers
  });
  if (process.env.NODE_ENV !== 'production'){
    require('longjohn');
  }

  var args = parseArgs();
  var opts = {
    log: log,
    port: args.server_port,
    host: args.server_host
  }
  if (args.use_tls) {
    _.merge(opts, {servername: args.server_host_override}, secureOptions);
  } else {
    _.merge(opts, insecureOptions);
  }
  if (_.has(args, 'server_host_override')) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  var testpb = protobuf.loadProto(path.join(__dirname, 'test.proto'));
  var interopCtor = buildClient(testpb.grpc.testing.TestService.client);
  var client = new interopCtor(opts);
  async.series([
    knownTests[args.test_case].bind(null, client),
    process.exit.bind(null, 0)  /* TODO enable client's to be closed */
  ]);
};

if (require.main === module) {
  main();
}
