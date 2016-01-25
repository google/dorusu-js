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
var buildApp = require('../interop/interop_server').buildApp;
var clientLog = require('./util').clientLog;
var serverLog = require('./util').serverLog;
var http2 = require('http2');
var insecureOptions = require('./util').insecureOptions;
var interopClient = require('../interop/interop_client');
var listenOnFreePort = require('./util').listenOnFreePort;
var nextAvailablePort = require('./util').nextAvailablePort;
var nurpc = require('../lib');
var path = require('path');

var GoAgent = require('../interop/go_interop_agent').GoAgent;

http2.globalAgent = new http2.Agent({ log: clientLog });

var testClientOptions = {
  secure: require('../example/certs').clientOptions,
  insecure: insecureOptions
};
testClientOptions.secure.rejectUnauthorized = false;

var TEST_PROTO_PATH = path.join(__dirname, '../interop/test.proto');

describe('External Interop Nodejs/Go', function() {
  /* Adjust the test timeout/duration; Go is spawned in a child proc */
  this.slow(5000);
  this.timeout(8000);

  var testpb = nurpc.pb.loadProto(TEST_PROTO_PATH);
  var Ctor = nurpc.buildClient(testpb.grpc.testing.TestService.client);
  var theClient, agent;
  _.forEach(testClientOptions, function(serverOpts, connType) {
    describe(connType, function() {
      before(function(done) {
        serverOpts.app = buildApp();
        var setUpClient = function setUpClient(err, theAgent) {
          if (err) {
            done(err);
            return;
          }
          agent = theAgent;
          var stubOpts = {log: clientLog};
          var serverAddr = {
            port: agent.port,
            address: 'localhost',
            family: 'IPv4'
          };
          _.merge(stubOpts, serverAddr, serverOpts);
          theClient = new Ctor(stubOpts);
          done();
        };
        makeGoServer(serverOpts, setUpClient);
      });
      after(function() {
        if (agent && agent.isServerRunning) {
          serverLog.info('stopping server', {'port': agent.port });
          agent.stopServer();
        }
      });
      var testCases = [
        'empty_unary',
        'large_unary',
        'cancel_after_begin',
        'server_streaming',
        'empty_stream',
        'ping_pong',
        'cancel_after_first_response',
        'client_streaming',
        'timeout_on_sleeping_server'
      ];
      _.forEach(testCases, function(t) {
        it('should pass the ' + t + ' interop test', function(done) {
          interopClient.runInteropTest(theClient, t, done);
        });
      });
    });
  });
});

var testServerOptions = {
  secure: require('../example/certs').serverOptions,
  insecure: insecureOptions
};

describe('External Interop Go/Nodejs', function() {
  /* Adjust the test timeout/duration; Go is spawned in a child proc */
  this.slow(3500);
  this.timeout(8000);

  var theAgent, server, serverAddr;
  _.forEach(testServerOptions, function(serverOpts, connType) {
    describe(connType, function() {
      before(function(done) {
        serverOpts.app = buildApp();
        server = makeNodeServer(serverOpts);
        listenOnFreePort(server, function(addr) {
          serverAddr = addr;
          var opts = {log: clientLog};
          _.merge(opts, serverAddr);
          theAgent = new GoAgent(opts);
          done();
        });
      });
      after(function() {
        server.close();
      });
      var testCases = [
        'cancel_after_begin',
        'cancel_after_first_response',
        'empty_unary',
        'large_unary',
        'client_streaming',
        'server_streaming',
        'ping_pong',
        'empty_stream',
        'timeout_on_sleeping_server'
      ];
      _.forEach(testCases, function(t) {
        it('should pass the ' + t + ' interop test' , function(done) {
          theAgent.runInteropTest(t, {secure: connType === 'secure'}, done);
        });
      });
    });
  });
});

function makeNodeServer(opts) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return nurpc.raw.createServer(opts, nurpc.unavailable);
  } else {
    return nurpc.createServer(opts, nurpc.unavailable);
  }
}

function makeGoServer(opts, done) {
  opts = _.clone(opts);
  opts.log = serverLog;
  var agent = null;
  var createAgent = function createAgent(addr) {
    var agentOpts = {};
    _.merge(agentOpts, addr, opts);
    agent = new GoAgent(agentOpts);
    var insecure = !!opts.plain;
    var startAgentServer =  function(err) {
      if (err) {
        done(err);
        return;
      }
      agent.startServer(!insecure, done);
    };
    agent._setupAndInstall(agent.testServerDir, startAgentServer);
  };
  nextAvailablePort(createAgent);
}
