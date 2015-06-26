'use strict';

/**
 * nurpc/example/math_client is an example client for the math.Math service.
 *
 * The math.Math service is defined in math.proto.
 *
 * @module nurpc/example/math_client
 */

var _ = require('lodash');
var async = require('async');
var bunyan = require('bunyan');
var buildClient = require('../lib/client').buildClient;
var expect = require('chai').expect;
var http2 = require('http2');
var insecureOptions = require('../test/util').insecureOptions;
var path = require('path');
var protobuf = require('../lib/protobuf');
var nurpc = require('../lib/nurpc');
var server = require('../lib/server');
var secureOptions = require('../test/util').secureOptions;

var Readable = require('stream').Readable;

var mathpb = protobuf.loadProto(path.join(__dirname, 'math.proto'));
var mathClientCls = buildClient(mathpb.math.Math.client);
var printVerified = false;

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
      if (printVerified) {
        console.log('Verified: ok div:', req, 'is', msg);
      }
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
    response.on('status', function(status) {
      if (printVerified) {
        console.log('Verified: stream div:', reqs, 'gives', got);
      }
      done();
    });
  });
};
var doStreamDiv = exports.doStreamDiv;

exports.doBadDiv = function doBadDiv(client, next) {
  var done = next || _.noop;
  var req = {dividend:7, divisor:0}
  client.div(req, function(response) {
    response.on('end', function() {
      done(null);
    });
    response.on('data', _.noop);
    response.on('error', function(error) {
      expect(error.code).to.eql(nurpc.rpcCode('INVALID_ARGUMENT'));
      if (printVerified) {
        console.log('Verified: bad div:', req, 'fails');
      }
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
      if (printVerified) {
        console.log('Verified: sum of', pushed, 'is', msg);
      }
    });
    response.on('end', function(status) {
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
    response.on('status', function(status) {
      if (printVerified) {
        console.log('Verified: fib of', req, 'is', got);
      }
      done();
    });
  });
};
var doOkFib = exports.doOkFib;


/**
 * Provides a command line entry point when this file is run as a script.
 */
var main = function main() {
  var log = bunyan.createLogger({
    name: 'math_client',
    stream: process.stderr,
    serializers: http2.serializers
  });
  var opts = {
    log: log,
    port: 50051,
    host: 'localhost'
  }
  _.merge(opts, insecureOptions);
  var client = new mathClientCls(opts);
  async.series([
    doOkDiv.bind(null, client),
    // doBadDiv.bind(null, client),
    doStreamDiv.bind(null, client),
    doOkSum.bind(null, client),
    doOkFib.bind(null, client),
    process.exit.bind(null, 0)  /* TODO figure out why this is needed */
  ]);
};

if (require.main === module) {
  printVerified = true;
  main();
}
