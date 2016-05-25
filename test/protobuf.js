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
var app = require('../lib/app');
var expect = require('chai').expect;
var path = require('path');
var protobuf = require ('../lib/protobuf');


var fixturePath = function fixturePath(p) {
  return path.join(__dirname, 'fixtures', p);
};

var examplePath = function examplePath(p) {
  return path.join(__dirname, '../example', p);
};

describe('`function loadProto(path, [format])`', function() {
  it('should load a proto file by default', function() {
    var isOK = function isOK() {
      protobuf.loadProto(fixturePath('test_service.proto'));
    };
    expect(isOK).to.not.throw(Error);
  });
  it('should load a proto file with the proto format', function() {
    var isOK = function isOK() {
      protobuf.loadProto(fixturePath('test_service.proto'), 'proto');
    };
    expect(isOK).to.not.throw(Error);
  });
  it('should load a json file with the json format', function() {
    var isOK = function isOK() {
      protobuf.loadProto(fixturePath('test_service.json'), 'json');
    };
    expect(isOK).to.not.throw(Error);
  });
  it('should fail to load a file with an unknown format', function() {
    var shouldThrow = function shouldThrow() {
      protobuf.loadProto(fixturePath('test_service.proto'), 'fake_format');
    };
    expect(shouldThrow).to.throw(Error);
  });
  it('should load a client defined in the proto file', function() {
    var testProto = protobuf.loadProto(fixturePath('test_service.proto'));
    var got = testProto.TestService.Client;
    expect(got).to.be.a('function');
    expect(got.name).to.eql('Client');
    expect(_.keys(got.prototype)).to.eql([
      'unary',
      'clientStream',
      'serverStream',
      'bidiStream']);
  });
  it('should load a client defined with a package', function() {
    var mathProto = protobuf.loadProto(examplePath('math.proto'));
    var got = mathProto.math.Math.Client;
    expect(got).to.be.a('function');
    expect(got.name).to.eql('Client');
    expect(_.keys(got.prototype)).to.eql(['div', 'divMany', 'fib', 'sum']);
  });
  it('should load a client that has a raw version', function() {
    var mathProto = protobuf.loadProto(examplePath('math.proto'));
    var got = mathProto.math.Math.Client;
    expect(got.raw).to.be.a('function');
    expect(got.raw.name).to.eql('RawClient');
    expect(_.keysIn(got.raw.prototype)).to.eql([
      'div',
      'divMany',
      'fib',
      'sum']);
  });
  it('should load a server defined in the proto file', function() {
    var testProto = protobuf.loadProto(fixturePath('test_service.proto'));
    var got = testProto.TestService.serverApp;
    expect(got).to.be.an.instanceof(app.RpcApp);
    expect(got.missingRoutes()).to.eql([
      '/TestService/Unary',
      '/TestService/ClientStream',
      '/TestService/ServerStream',
      '/TestService/BidiStream'
    ]);
  });
  it('should load a server defined with a package', function() {
    var mathProto = protobuf.loadProto(examplePath('math.proto'));
    var got = mathProto.math.Math.serverApp;
    expect(got).to.be.an.instanceof(app.RpcApp);
    expect(got.missingRoutes()).to.eql([
      '/math.Math/Div',
      '/math.Math/DivMany',
      '/math.Math/Fib',
      '/math.Math/Sum'
    ]);
  });
});

describe('`function requireProto(path, [format])`', function() {
  var absolutePath = fixturePath('test_service');
  describe('when using an absolute path', function()  {
    it('should "require" a proto file without an extension', function() {
      var isOK = function isOK() {
        protobuf.requireProto(absolutePath);
      };
      expect(isOK).to.not.throw(Error);
    });
    it('should "require" a proto file with an extension', function() {
      var isOK = function isOK() {
        protobuf.requireProto(absolutePath + '.proto');
      };
      expect(isOK).to.not.throw(Error);
    });
  });
  var localPath = './fixtures/test_service';
  describe('when using a relative path', function()  {
    it('should "require" a proto file without an extension', function() {
      var isOK = function isOK() {
        protobuf.requireProto(localPath, require);
      };
      expect(isOK).to.not.throw(Error);
    });
    it('should "require" a proto file with an extension', function() {
      var isOK = function isOK() {
        protobuf.requireProto(localPath + '.proto', require);
      };
      expect(isOK).to.not.throw(Error);
    });
  });
  it('should "require" a client defined in the proto', function() {
    var testProto = protobuf.requireProto(localPath, require);
    var got = testProto.TestService.Client;
    expect(got).to.be.a('function');
    expect(got.name).to.eql('Client');
    expect(_.keys(got.prototype)).to.eql([
      'unary',
      'clientStream',
      'serverStream',
      'bidiStream']);
  });
  it('should "require" a client that has a raw version', function() {
    var testProto = protobuf.requireProto(localPath, require);
    var got = testProto.TestService.Client;
    expect(got.raw).to.be.a('function');
    expect(got.raw.name).to.eql('RawClient');
    expect(_.keysIn(got.raw.prototype)).to.eql([
      'unary',
      'clientStream',
      'serverStream',
      'bidiStream']);
  });
  it('should "require" a server defined in the proto', function() {
    var testProto = protobuf.requireProto(localPath, require);
    var got = testProto.TestService.serverApp;
    expect(got).to.be.an.instanceof(app.RpcApp);
    expect(got.missingRoutes()).to.eql([
      '/TestService/Unary',
      '/TestService/ClientStream',
      '/TestService/ServerStream',
      '/TestService/BidiStream'
    ]);
  });
});
