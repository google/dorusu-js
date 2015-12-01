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
  it('should load service defined in the proto', function() {
    var testProto = protobuf.loadProto(fixturePath('test_service.proto'));
    _.forEach(['client', 'server'], function(side) {
      var got = testProto.TestService[side];
      expect(got).to.be.an.instanceof(app.Service);
      expect(got.name).to.eql('TestService');
      var methods = _.map(got.methods, function(m) { return m.name; });
      expect(methods).to.eql(['Unary', 'ClientStream', 'ServerStream',
                              'BidiStream']);
    });
  });
  it('should load service defined in a proto with a package', function() {
    var mathProto = protobuf.loadProto(examplePath('math.proto'));
    _.forEach(['client', 'server'], function(side) {
      var got = mathProto.math.Math[side];
      expect(got).to.be.an.instanceof(app.Service);
      expect(got.name).to.eql('math.Math');
      var methods = _.map(got.methods, function(m) { return m.name; });
      expect(methods).to.eql(['Div', 'DivMany', 'Fib', 'Sum']);
    });
  });
});
