define(function (require) {

  var _ = require('lodash');

  return function QueryHelperFactory(Private, Promise, timefilter, indexPatterns) {

    var kibiTimeHelper   = Private(require('components/kibi/kibi_time_helper/kibi_time_helper'));

    function QueryHelper() {
    }

    // constructs an or filter
    // http://www.elasticsearch.org/guide/en/elasticsearch/reference/current/query-dsl-or-filter.html
    QueryHelper.prototype.constructOrFilter = function (esFieldName, ids, meta) {
      if (!ids || (ids.length === 0)) {
        return false;
      }
      if (!esFieldName) {
        return false;
      }
      if (!meta.value) {
        return false;
      }

      var orFilter = {
        or: [],
        meta: {}
      };
      // add extra metadata to the filter
      if (meta) {
        _.assign(orFilter.meta, meta);
      }

      _.each(ids, function (id) {
        var clause = {
          term: {}
        };
        clause.term[esFieldName] = id;
        orFilter.or.push(clause);
      });
      return orFilter;
    };

    /**
     * GetLabels returns the set of indices which are connected to the focused index,
     * i.e., the connected component of the graph.
     */
    var _getLabelsInConnectedComponent = QueryHelper.prototype.getLabelsInConnectedComponent = function (focus, relations) {
      var labels = [];
      var dotFocus = focus + '.';

      // the set of current nodes to visit
      var current = [ dotFocus ];
      // the set of nodes to visit in the next iteration
      var toVisit = [];
      // the set of visited nodes
      var visited = [];

      /**
       * Returns the index in current of the element that starts with relation, and -1 otherwise.
       */
      function indexOf(current, relation) {
        for (var i = 0; i < current.length; i++) {
          if (relation.indexOf(current[i]) === 0) {
            return i;
          }
        }
        return -1;
      }

      do {

        // for each relation:
        // - if some node is in the current ones, then add the adjacent
        // node to toVisit if it was not visited already
        for (var i = 0; i < relations.length; i++) {
          var ind = -1;

          if ((ind = indexOf(current, relations[i][0])) !== -1) {
            var label1 = relations[i][1].substring(0, relations[i][1].indexOf('.') + 1);
            if (label1 !== current[ind] && visited.indexOf(label1) === -1) {
              toVisit.push(label1);
            }
          } else if ((ind = indexOf(current, relations[i][1])) !== -1) {
            var label2 = relations[i][0].substring(0, relations[i][0].indexOf('.') + 1);
            if (label2 !== current[ind] && visited.indexOf(label2) === -1) {
              toVisit.push(label2);
            }
          }
        }

        // update the visisted set
        for (var j = current.length - 1; j >= 0; j--) {
          // minus the trailing dot
          labels.push(current[j].substring(0, current[j].length - 1));
          visited.push(current.pop());
        }
        // update the current set
        for (var k = toVisit.length - 1; k >= 0; k--) {
          current.push(toVisit.pop());
        }

      } while (current.length !== 0);

      return labels;
    };

    // filters should be an object
    // {
    //   indexId1: [],
    //   indexId2: [],
    //   ...
    // }
    QueryHelper.prototype.constructJoinFilter = function (focus, indexes, relations, filters, queries, indexToDashboardMap) {
      return new Promise(function (fulfill, reject) {
        // compute part of the label
        var labels = _getLabelsInConnectedComponent(focus, relations);
        labels.sort();

        var labelValue = '';
        for (var i = 0; i < labels.length; i++) {
          if (i === 0) {
            labelValue = labels[0];
          } else if (labels[i] !== labels[i - 1]) {
            labelValue += ' <-> ' + labels[i];
          }
        }

        var joinFilter = {
          meta: {
            value: labelValue
          },
          join: {
            focus: focus,
            indexes: indexes,
            relations: relations,
            filters: {}
          }
        };

        // here iterate over queries and add to the filters only this one which are not for focused index
        for (var index in queries) {
          if (queries.hasOwnProperty(index) && index !== focus) {
            var fQuery = queries[index];
            if (fQuery && fQuery.query_string && fQuery.query_string.query !== '*') {
              if (!joinFilter.join.filters[index]) {
                joinFilter.join.filters[index] = [];
              }
              joinFilter.join.filters[index].push({
                query: {
                  query_string: fQuery.query_string
                }
              });
            }
          }
        }

        if (filters) {
          for (var f in filters) {
            if (filters.hasOwnProperty(f) && f !== focus && filters[f] instanceof Array && filters[f].length > 0) {
              if (!joinFilter.join.filters[f]) {
                joinFilter.join.filters[f] = [];
              }


              for (i = 0; i < filters[f].length; i++) {
                var filter = filters[f][i];
                if (filter.meta && filter.meta.negate === true) {
                  delete filter.meta;
                  filter = {
                    not: filter
                  };
                } else if (filter.meta) {
                  delete filter.meta;
                }

                joinFilter.join.filters[f].push(filter);
              }

            }
          }
        }

        // update the timeFilter
        var promises = _.chain(indexes)
        .filter(function (index) {
          return index.id !== focus;
        })
        .map(function (index) {
          return new Promise(function (fulfill, reject) {
            indexPatterns.get(index.id).then(function (indexPattern) {
              // 1 check if there is a timefilter for this index
              var timeFilter = timefilter.get(indexPattern);
              if (timeFilter) {
                if (indexToDashboardMap) {
                  var dashboardId = indexToDashboardMap[indexPattern.id];
                  // update the timeFilter and add it to filters
                  kibiTimeHelper.updateTimeFilterForDashboard(dashboardId, timeFilter).then(function (updatedTimeFilter) {
                    fulfill({
                      index: index,
                      timeFilter: updatedTimeFilter
                    });
                  });
                } else {
                  fulfill({
                    index: index,
                    timeFilter: timeFilter
                  });
                }
              } else {
                // here resolve the promise with no filter just so the number of resolved one matches
                fulfill(null);
              }
            }).catch(function (err) {
              fulfill(null);
            });
          });
        }).value();

        Promise.all(promises).then(function (data) {
          // add time filters on their respective index
          for (var i = 0; i < data.length; i++) {
            if (data[i]) {
              // here we add a time filter to correct filters
              if (!joinFilter.join.filters[data[i].index.id]) {
                joinFilter.join.filters[data[i].index.id] = [];
              }
              joinFilter.join.filters[data[i].index.id].push(data[i].timeFilter);
            }
          }

        }).finally(function () {
          fulfill(joinFilter);
        });

      });
    };

    return new QueryHelper();
  };

});
