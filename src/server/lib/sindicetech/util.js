var _ = require('lodash');
var Promise = require('bluebird');
var kibiUtils = require('kibiutils');

// The string used for separating the componements of a JSON path
var PATH_SEPARATOR = '!"£$%^&*_+';

/**
 * Traverse the JSON object and modify each label nested objects with the
 * output of the apply callback.
 */
exports.traverse = function (json, label, apply) {
  return _traverse0(json, [], label, apply, '');
};

/**
 * Traverse the JSON object and collect the promises for modifying that object
 */
function _traverse0(json, objects, label, apply, curPath) {
  // visit each attribute
  for (var attribute in json) {
    if (json.hasOwnProperty(attribute)) {
      if (attribute === label) {
        // attribute to modify is found
        if (json[attribute] === null || typeof (json[attribute]) !== 'object') {
          apply(new Error('Unexpected value for [' + label + ']'), null);
        } else {
          objects.push({
            path: curPath.length === 0 ? [] : curPath.split(PATH_SEPARATOR),
            value: apply(null, json[attribute])
          });
        }
      }
      // Go down to the nested object
      if (json[attribute] !== null && typeof (json[attribute]) === 'object') {
        if (curPath) {
          _traverse0(json[attribute], objects, label, apply, curPath + PATH_SEPARATOR + attribute);
        } else {
          _traverse0(json[attribute], objects, label, apply, attribute);
        }
      }
    }
  }
  return objects;
}


/**
 * Add all the elements in the given array to the array in the json at the given path
 */
exports.addAll = function (json, path, array) {
  kibiUtils.goToElement(json, path, function (json) {
    if (json.constructor === Array) {
      for (var j = 0; j < array.length; j++) {
        json.push(array[j]);
      }
    } else {
      throw new Error('AddAll can only add elements to an array: got ' + JSON.stringify(json, null, ' '));
    }
  });
};

/**
 * Replace the label object at the given path in json with the given object
 */
exports.replace = function (json, path, label, object) {
  kibiUtils.goToElement(json, path, function (json) {
    // remove the custom query
    delete json[label];
    // replace it with the ES query
    json.bool = object;
  });
};

/**
 * Insert all the elements of the object at the given path in json
 */
exports.insert = function (json, path, object) {
  kibiUtils.goToElement(json, path, function (json) {
    for (var att in object) {
      if (object.hasOwnProperty(att)) {
        json[att] = object[att];
      }
    }
  });
};

/**
 * Returns the size of the element at the given path.
 */
exports.length = function (json, path) {
  var len = 0;

  kibiUtils.goToElement(json, path, function (json) {
    for (var att in json) {
      if (json.hasOwnProperty(att)) {
        len++;
      }
    }
  });
  return len;
};

/**
 * Delete deletes the label entry at the given path in json
 */
exports.delete = function (json, path, label) {
  kibiUtils.goToElement(json, path, function (json) {
    if (json.constructor === Object) {
      delete json[label];
    } else if (json.constructor === Array) {
      json.splice(parseInt(label, 10), 1);
    } else {
      throw new Error('Unable to delete element ' + label + ' in ' + JSON.stringify(json, null, ' '));
    }
  });
};

/**
 * GetQueriesAsPromise returs an array of promises, which elements are the queries
 * contained in the given body, one per line.
 */
exports.getQueriesAsPromise = function (body) {
  var process = function (body, start, end) {
    var query = JSON.parse(body.toString(null, start, end));
    return Promise.resolve(query);
  };
  return Promise.all(_getQueries(body, process));
};

/**
 * GetQueries returs an array of queries that were
 * contained in the given body, one per line.
 */
exports.getQueries = function (body) {
  var process = function (body, start, end) {
    var query = JSON.parse(body.toString(null, start, end));
    return query;
  };
  return _getQueries(body, process);
};

function _getQueries(body, process) {
  var start = 0;
  var promisedQueries = [];

  // for each query in the body
  for (var i = 0; i < body.length; i++) {
    // 10 is a newline char point
    if (body[i] === 10) {
      promisedQueries.push(process(body, start, i));
      start = i + 1;
    } else if (i + 1 === body.length) {
      // process the last query
      promisedQueries.push(process(body, start, body.length));
    }
  }
  return promisedQueries;
}
