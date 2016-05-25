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
 * dorusu/example/math_client is an example client for the math.Math service.
 *
 * The math.Math service is defined in math.proto.
 *
 * Example usage:
 *
 * Access the default insecure server
 * ```sh
 * $ example/math_client.js
 * ```
 *
 * Access a secure server with info logging
 * ```sh
 * $ HTTP2_LOG=info example/math_client.js -h my.domain.io -s 2> >(bunyan)
 * ```
 *
 * Print full usage
 * ```sh
 * $ example/math_client.js -h
 * ```
 *
 * @module dorusu/example/math_client
 */

var _ = require('lodash');
var async = require('async');
var bunyan = require('bunyan');
var expect = require('chai').expect;
var http2 = require('http2');
var insecureOptions = require('../test/util').insecureOptions;
var dorusu = require('../lib');
var secureOptions = require('../test/util').secureClientOptions;

var ArgumentParser = require('argparse').ArgumentParser;
var Readable = require('stream').Readable;

// By default, functions use the (noop) logger; main() assigns a real
// logger implementation.
var log = dorusu.noopLogger;

exports.doOkDiv = function doOkDiv(client, next) {
  var done = next || _.noop;
  var req = {dividend:7, divisor:3};
  client.div(req, function(response) {
    response.on('end', function() {
      done(null);
    });
    response.on('data', function(msg) {
      expect(+msg.quotient).to.eql(2);
      expect(+msg.remainder).to.eql(1);
      log.info('Verified: ok div:', req, 'is', msg);
    });
  });
};
var doOkDiv = exports.doOkDiv;

exports.doStreamDiv = function doStreamDiv(client, next) {
  var done = next || _.noop;
  var reqs = [], got = [];

  // Create a stream of requests to be processed.
  var sumSrc = new Readable({objectMode: true});
  for (var i = 0; i < 5; i++) {  // TODO: ways of setting to be delayed
    var nextReq = {dividend: 3 * i + 2, divisor: 3};
    reqs.push(nextReq);
    sumSrc.push(nextReq);
  }
  sumSrc.push(null);
  client.divMany(sumSrc, function(response) {
    var next_index = 0;
    response.on('data', function(msg) {
      expect(+msg.quotient).to.equal(next_index);
      expect(+msg.remainder).to.equal(2);
      got.push(msg);
      next_index += 1;
    });
    response.on('status', function() {
      log.info('Verified: stream div:', reqs, 'gives', got);
      done();
    });
  });
};
var doStreamDiv = exports.doStreamDiv;

exports.doBadDiv = function doBadDiv(client, next) {
  var done = next || _.noop;
  var req = {dividend:7, divisor:0};
  client.div(req, function(response) {
    response.on('end', function() {
      done(null);
    });
    response.on('data', _.noop);
    response.on('error', function(error) {
      expect(error.code).to.eql(dorusu.rpcCode('INVALID_ARGUMENT'));
      log.info('Verified: bad div:', req, 'fails');
    });
  });
};
var doBadDiv = exports.doBadDiv;

exports.doOkSum = function doOkSum(client, next) {
  var done = next || _.noop;
  var sumSrc = new Readable({objectMode: true});
  var want = 0;
  var pushed = [];
  for (var i = 0; i < 7; i++) {
    var toPush = {'num': i};
    sumSrc.push(toPush);
    pushed.push(toPush);
    want += i;
  }
  sumSrc.push(null);
  client.sum(sumSrc, function(response) {
    response.on('data', function(msg) {
      expect(+msg.num).to.equal(want);
      log.info('Verified: sum of', pushed, 'is', msg);
    });
    response.on('end', function() {
      done(null);
    });
  });
};
var doOkSum = exports.doOkSum;

exports.doOkFib = function doOkFib(client, next) {
  var done = next || _.noop;
  var req = {limit:7};
  client.fib(req, function(response) {
    var want = [1, 1, 2, 3, 5, 8, 13];
    var got = [];
    var next_index = 0;
    response.on('data', function(msg) {
      expect(+msg.num).to.equal(want[next_index]);
      got.push(msg);
      next_index += 1;
    });
    response.on('status', function() {
      log.info('Verified: fib of', req, 'is', got);
      done();
    });
  });
};
var doOkFib = exports.doOkFib;

/**
 * parseArgs parses the command line options/arguments when this file is run as
 * a script.
 */
var parseArgs = function parseArgs() {
  var parser = new ArgumentParser({
    version: require('../package').version,
    addHelp:true,
    description: 'Dorusu Node.js Math Client example.\n' +
                 'It accesses an example Math Server and performs sample' +
                 ' RPCs.'
  });
  parser.addArgument(
    [ '-a', '--address' ],
    {
      help: 'The Math Server hostname',
      defaultValue: 'localhost'
    }
  );
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
            ' securely using the example test credentials.'
    }
  );
  return parser.parseArgs();
};

/**
 * main is the command line entry point when this file is run as a script.
 */
var main = function main() {
  log = bunyan.createLogger({
    level: process.env.HTTP2_LOG || 'info',
    name: 'math_client',
    stream: process.stdout,
    serializers: http2.serializers
  });
  var args = parseArgs();
  var opts = {
    log: log,
    port: args.port,
    host: args.address
  };
  if (args.use_tls) {
    _.merge(opts, secureOptions);
  } else {
    _.merge(opts, insecureOptions);
  }
  var mathpb = dorusu.pb.requireProto('./math', require);
  var client = new mathpb.math.Math.Client(opts);
  async.series([
    doOkDiv.bind(null, client),
    doBadDiv.bind(null, client),
    doStreamDiv.bind(null, client),
    doOkSum.bind(null, client),
    doOkFib.bind(null, client),
    process.exit.bind(null, 0)  /* TODO: replace once clients have #close */
  ]);
};

if (require.main === module) {
  main();
}
