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
var buildApp = require('../example/math_server').buildApp;
var clientLog = require('./util').clientLog;
var serverLog = require('./util').serverLog;
var http2 = require('http2');
var insecureOptions = require('./util').insecureOptions;
var listenOnFreePort = require('./util').listenOnFreePort;
var mathClient = require('../example/math_client');
var dorusu = require('../lib');
var secureOptions = require('../example/certs').options;

http2.globalAgent = new http2.Agent({ log: clientLog });

var mathpb = dorusu.pb.requireProto('../example/math');
var MathClient = mathpb.math.Math.Client;
var testOptions = {
  secure: _.merge(_.clone(secureOptions), {
    rejectUnauthorized: false
  }),
  insecure: _.clone(insecureOptions)
};

describe('Math Client', function() {
  var client, server, serverAddr;
  _.forEach(testOptions, function(serverOpts, connType) {
    describe(connType, function() {
      before(function(done) {
        serverOpts.app = buildApp();
        server = makeServer(serverOpts);
        var stubOpts = {};
        listenOnFreePort(server, function(addr) {
          serverAddr = addr;
          _.merge(stubOpts, serverAddr, serverOpts);
          if (connType === 'secure') {
            client = new MathClient(stubOpts);
          } else {
            client = new MathClient.raw(stubOpts);
          }
          done();
        });
      });
      after(function() {
        server.close();
      });
      it('should error on `div` with a 0 divisor', function(done) {
        mathClient.doBadDiv(client, done);
      });
      it('should get the correct answer for `div`', function(done) {
        mathClient.doOkDiv(client, done);
      });
      it('should get the correct response for `fib`', function(done) {
        mathClient.doOkFib(client, done);
      });
      it('should get the correct response for `sum`', function(done) {
        mathClient.doOkSum(client, done);
      });
      it('should get the correct response for `divMany`', function(done) {
        mathClient.doStreamDiv(client, done);
      });
    });
  });
});

function makeServer(opts) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return dorusu.raw.createServer(opts, dorusu.unavailable);
  } else {
    return dorusu.createServer(opts, dorusu.unavailable);
  }
}
