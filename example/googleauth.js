/**
 * nurpc/googleauth provides a header update function based on
 * google-auth-library.
 *
 * @module nurpc/googleauth
 */

var _ = require('lodash');
var GoogleAuth = require('google-auth-library');
var AuthFactory = new GoogleAuth();

/**
 * Get a function that a client can use to update headers with authorization
 * tokens from a Google Auth credential object.
 *
 * @return {function(authUri, headers, done)} A function that updates the
 *   headers passed and invokes done with the result
 */
exports.updateHeadersFunc = function updateHeadersFunc() {
  /**
   * Update a metadata object with authentication information.
   *
   * @param {string} opt_authURI The uri to authenticate to
   * @param {Object} headers the current headers
   * @param {function(Error, Object)} done the node completion callback
   */
  return function updateHeaders(opt_authURI, headers, done) {
    AuthFactory.getApplicationDefault(function(err, credential) {
      if (err) {
        done(err);
        return;
      }
      headers = _.clone(headers);
      credential.getRequestMetadata(opt_authURI, function(err, authHdrs) {
        if (err) {
          done(err);
          return;
        }
        _.merge(headers, authHdrs)
        done(null, headers);
      });
    });
  };
};
