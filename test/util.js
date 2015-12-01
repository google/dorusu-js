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
var path = require('path');
var fs = require('fs');
var http2  = require('http2');
var net = require('net');
var spawn = require('child_process').spawn;


if (process.env.HTTP2_LOG) {
  var logOutput = process.stderr;
  if (process.stderr.isTTY) {
    var bin = path.resolve(path.dirname(require.resolve('bunyan')), '..', 'bin', 'bunyan');
    if(bin && fs.existsSync(bin)) {
      logOutput = spawn(bin, ['-o', 'short'], {
        stdio: [null, process.stderr, process.stderr]
      }).stdin;
    }
  }
  exports.createLogger = function(name) {
    return require('bunyan').createLogger({
      name: name,
      stream: logOutput,
      level: process.env.HTTP2_LOG,
      serializers: http2.protocol.serializers
    });
  };
  exports.log = exports.createLogger('test');
  exports.clientLog = exports.createLogger('client');
  exports.serverLog = exports.createLogger('server');
} else {
  exports.createLogger = function() {
    return exports.log;
  };
  exports.log = exports.clientLog = exports.serverLog = {
    fatal: _.noop,
    error: _.noop,
    warn : _.noop,
    info : _.noop,
    debug: _.noop,
    trace: _.noop,

    child: function() { return this; }
  };
}

exports.callNTimes = function callNTimes(limit, done) {
  if (limit === 0) {
    done();
  } else {
    var i = 0;
    return function() {
      i += 1;
      if (i === limit) {
        done();
      }
    };
  }
};

exports.insecureOptions = {
  protocol: 'http:',
  plain: true
};

/**
 * Finds a free port that a server can bind to, return an address
 *
 * @param {function(addr)} done is called with the free address
 */
exports.nextAvailablePort = function nextAvailablePort(done) {
  var server = net.createServer();
  server.listen(function() {
    var addr = server.address();
    server.close(function() {
      done(addr);
    });
  });
};

/**
 * Runs `srv` on the next available free port, and executes a `clientTask` that
 * may access the running server.
 *
 * clientTasks is a function(addr, srv) where addr represents the address that
 * server is running and srv is the srv instance.
 *
 * @param {object} srv a server instance
 * @param {function} clientTask as described above
 */
exports.listenOnFreePort = function listenOnFreePort(srv, clientTask) {
  var startServer = function startServer(addr) {
    srv.listen(addr.port, function() {
      clientTask(addr, srv);
    });
  };
  exports.nextAvailablePort(startServer);
};

exports.random = function random(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
};

// reverser is used as a test serialization func
exports.reverser = function reverser(s) {
  var r = s.toString().split('').reverse().join('');
  return new Buffer(r);
};

// irreverser is used as a test deserialization func
exports.irreverser = function irreverser(s) {
  return s.toString().split('').reverse().join('');
};
