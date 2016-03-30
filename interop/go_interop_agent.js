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

var _ = require('lodash');
var async = require('async');
var child_process = require('child_process');
var fs = require('fs-extra');
var path = require('path');
var os = require('os');

/**
 * dorusu/interop/go_interop_agent provides a class GoAgent that supports
 * running the Go interop tests in test cases.
 *
 * It can also be run as a script that install, launches and runs the GoAgent
 * server.  This might be useful to do as a precursor to running the Go interop
 * tests.
 */

/**
 * Internal constants
 */

/* Need to wait around 3s to ensure Go server is up */
var STARTUP_WAIT_MILLIS = 3000;
var PKG_NAME = 'google.golang.org/grpc';
var PKGS = Object.freeze([
  PKG_NAME,
  'golang.org/x/net/context',
  'golang.org/x/net/http2',
  'golang.org/x/net/http2/hpack',
  'golang.org/x/net/trace',
  'golang.org/x/oauth2',
  'golang.org/x/oauth2/google',
  'golang.org/x/oauth2/jwt'
]);
var CLIENT_PATH = PKG_NAME + '/interop/client';
var SERVER_PATH = PKG_NAME + '/interop/server';
var SERVER_PORT = 50443;
var DEFAULT_TEST_ROOT = path.join(os.tmpdir(), 'dorusu_tests');

/**
 * Is Go available ?
 */
var isThereGo = function isThereGo() {
  try {
    child_process.execFileSync('go', 'version');
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Is the process with pid alive ?
 */
var isPidAlive = function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Stops a process
 */
var stopProcess = function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (e) {
    return false;
  }
};

exports.GoAgent = GoAgent;

/**
 * GoAgent runs the Go interop tests
 */
function GoAgent(opts) {
  opts = opts || {};
  this.port = opts.port || SERVER_PORT;
  this._log = opts.log;
  this.otherServerPids = [];
  this.serverPid = null;
  this.testRoot = opts.testRoot || process.env.NURPC_TEST_ROOT ||
      DEFAULT_TEST_ROOT;
  this.forceRun = false;

  /**
   * testDir is the Go specific test directory.
   */
  Object.defineProperty(this, 'testDir', {
    get: function() { return path.join(this.testRoot, 'go'); }
  });

  /**
   * testServerDir is the directory of the Go server binary.
   */
  Object.defineProperty(this, 'testServerDir', {
    get: function() { return path.join(this.testDir, 'src', SERVER_PATH); }
  });

  /**
   * testEnv are the process environment variables to use when
   * invoking the test client or server.
   */
  Object.defineProperty(this, 'testEnv', {
    get: function() { return _.merge({'GOPATH': this.testDir}, process.env); }
  });

  /**
   * testClientDir is the directory of the Go client binary.
   */
  Object.defineProperty(this, 'testClientDir', {
    get: function() { return path.join(this.testDir, 'src', CLIENT_PATH); }
  });

  /**
   * shouldRun determines if the Go interop test should run?
   */
  Object.defineProperty(this, 'shouldRun', {
    get: function() { return this.forceRun || isThereGo(); }
  });

  /**
   * isServerRunning indicates if the interop server is already running.
   */
  Object.defineProperty(this, 'isServerRunning', {
    get: function() {
      return !_.isNull(this.serverPid) && isPidAlive(this.serverPid);
    }
  });
}
GoAgent.prototype =
  Object.create(Object.prototype, { constructor: { value: GoAgent } });

GoAgent.prototype._setupAndInstall =
  function _setupAnInstall(installDir, done) {
    fs.mkdirsSync(this.testDir);
    var tasks = [];
    var that = this;
    PKGS.forEach(function(p) {
      tasks.push(
        child_process.execFile.bind(
          child_process, 'go', ['get', p], {env: that.testEnv}));
    });
    tasks.push(
      child_process.execFile.bind(child_process, 'go', ['install'], {
        cwd: installDir,
        env: that.testEnv
      })
    );
    async.series(tasks, done);
  };

GoAgent.prototype.startServer = function startServer(secure, done) {
  if (this.isServerRunning) {
    done(null, this);
    return;
  }
  this.serverPid = null;
  var use_tls = secure ? 'true' : 'false';
  var args = [
    'run', 'server.go',
    '--use_tls=' + use_tls,
    '--port=' + this.port
  ];
  if (this._log) {
    this._log.info({
      args: args,
      cwd: this.testServerDir
    }, 'Running interop server');
  }
  var job = child_process.spawn('go', args, {
    cwd: this.testServerDir,
    env: this.testEnv
  });
  job.on('error', function(err) {
    if (this._log) {
      this._log.error({error: err}, 'Go server crashed');
    }
  });
  this.serverPid = job.pid;
  var waitForServer = function waitForServer() {
    if (this.isServerRunning) {
      if (this._log) {
        this._log.info({
          pid: this.serverPid,
          port: this.port,
          running: this.isServerRunning
        }, 'Go Server started OK');
      }
      done(null, this);
    } else {
      if (this._log) {
        this._log.info({
          pid: this.serverPid,
          port: this.port,
          running: this.isServerRunning
        }, 'Go Server did not start OK');
      }
      this.stopServer();
      done(new Error('Go Server startup failed'));
    }
  }.bind(this);
  setTimeout(waitForServer, STARTUP_WAIT_MILLIS);
};

GoAgent.prototype.stopServer = function stopServer() {
  if (!this.isServerRunning) {
    return;
  }
  stopProcess(this.serverPid);
};

GoAgent.prototype.runInteropTest =
  function runInteropTest(testCase, opts, next) {
    opts = opts || {};
    opts.port = opts.port || this.port || SERVER_PORT;
    if (_.isUndefined(opts.secure)) {
      opts.secure = true;
    }
    var useTls = opts.secure ? 'true' : 'false';
    var args = [
      'run', 'client.go',
      '--use_tls=' + useTls,
      '--use_test_ca=true',
      '--server_host_override=foo.test.google.fr',
      '--server_host=localhost',
      '--server_port=' + opts.port,
      '--test_case=' + testCase
    ];
    if (this._log) {
      this._log.info({
        args: args,
        cwd: this.testClientDir
      }, 'Running interop test');
    }
    var job = child_process.execFile('go', args, {
      cwd: this.testClientDir,
      env: this.testEnv
    }, next);
    job.on('error', function(err) {
      if (this._log) {
        this._log.error({error: err}, 'Go server failed');
      }
    });
  };

/**
 * main allows this to be file to be run as a script that installs the Go
 * interop agent client and server in the temporary directory that will be used
 * by the interop tests.
 */
var main = function main() {
  var agent = new GoAgent();
  var setupTargets = {
      client: agent.testClientDir,
      server: agent.testServerDir
  };
  _.forEach(setupTargets, function(targetDir, name) {
    console.log('Agent %s directory is %s', name, targetDir);
    agent._setupAndInstall(
      targetDir,
      function(err) {
        if (err) {
          console.log('Setup in %s failed: %s', targetDir, err);
        } else {
          console.log('Setup in %s succeeded', targetDir);
        }
      }
    );
  });
};

if (require.main === module) {
  main();
}
