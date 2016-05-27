/*
 *
 * Copyright 2016, Google Inc.
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
var chai = require('chai');
chai.use(require('dirty-chai'));
var expect = chai.expect;
var rewire = require('rewire');

describe('method `googleauth.addAuthFromADC`', function() {
  var authModule,
      authHeaders = {authHdr: 'an-auth-token'},
      fakeScopes = ['scope1', 'scope2'],
      startHeaders = {
        k1: 'v1',
        k2: 'v2'
      },
      fakeUri = 'fake://test/uri';

  beforeEach(function() {
    authModule = rewire('../lib/googleauth');
  });

  it('should return a function', function() {
    var f = authModule.addAuthFromADC(fakeScopes);
    expect(f).to.be.an.instanceof(Function);
  });

  describe('the returned function', function() {
    it('should propagate a failure to obtain the credentials', function() {
      var credError = new Error('could not get creds'),
          fakeAuth = {
            getApplicationDefault: function(authCb) {
              authCb(credError);
            }
          },
          gotError = null,
          gotHeaders = null,
          next = function next(err, headers) {
            gotError = err;
            gotHeaders = headers;
          };
      authModule.__set__('AuthFactory', fakeAuth);

      var updateHeaders = authModule.addAuthFromADC(fakeScopes);
      updateHeaders(null, startHeaders, next);
      expect(gotError).to.eql(credError);
      expect(gotHeaders).to.be.undefined();
    });
    it('should propagate a failure to update the headers', function() {
      var updateError = new Error('could not update headers'),
          fakeCred = {
            getRequestMetadata: function(optUri, headersCb) {
              headersCb(updateError);
            }
          },
          fakeAuth = {
            getApplicationDefault: function(authCb) {
              authCb(null, fakeCred);
            }
          },
          gotError = null,
          gotHeaders = null,
          next = function next(err, headers) {
            gotError = err;
            gotHeaders = headers;
          };
      authModule.__set__('AuthFactory', fakeAuth);

      var updateHeaders = authModule.addAuthFromADC(fakeScopes);
      updateHeaders(null, startHeaders, next);
      expect(gotError).to.eql(updateError);
      expect(gotHeaders).to.be.undefined();
    });
    it('should update the headers', function() {
      var gotUri = null,
          fakeCred = {
            getRequestMetadata: function(optUri, headersCb) {
              gotUri = optUri;
              headersCb(null, authHeaders);
            }
          },
          fakeAuth = {
            getApplicationDefault: function(authCb) {
              authCb(null, fakeCred);
            }
          },
          gotError = null,
          gotHeaders = null,
          next = function next(err, headers) {
            gotError = err;
            gotHeaders = headers;
          };
      authModule.__set__('AuthFactory', fakeAuth);

      var updateHeaders = authModule.addAuthFromADC(fakeScopes);
      updateHeaders(fakeUri, startHeaders, next);
      var want = _.merge(_.clone(startHeaders), authHeaders);
      expect(gotError).to.eql(null);
      expect(gotHeaders).to.eql(want);
      expect(gotUri).to.eql(fakeUri);
    });
    it('should use scopes to update the headers if necessary', function() {
      var gotScopes = null,
          fakeCred = {
            getRequestMetadata: function(optUri, headersCb) {
              headersCb(null, authHeaders);
            },
            createScopedRequired: function() { return true; },
            createScoped: function(scopes) {
              gotScopes = scopes;
              return fakeCred;
            }
          },
          fakeAuth = {
            getApplicationDefault: function(authCb) {
            authCb(null, fakeCred);
            }
          },
          gotError = null,
          gotHeaders = null,
          next = function next(err, headers) {
            gotError = err;
            gotHeaders = headers;
          };
      authModule.__set__('AuthFactory', fakeAuth);

      var updateHeaders = authModule.addAuthFromADC(fakeScopes);
      updateHeaders(null, startHeaders, next);
      var want = _.merge(_.clone(startHeaders), authHeaders);
      expect(gotScopes).to.eql(fakeScopes);
      expect(gotError).to.eql(null);
      expect(gotHeaders).to.eql(want);
    });
  });
});
