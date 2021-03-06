define(function (require) {
  var _ = require('lodash');
  var angular = require('angular');
  var inflection = require('inflection');
  var rison = require('utils/rison');
  var registry = require('plugins/settings/saved_object_registry');
  var objectViewHTML = require('text!plugins/settings/sections/objects/_view.html');

  require('routes')
  .when('/settings/objects/:service/:id', {
    template: objectViewHTML
  });

  require('modules').get('apps/settings')
  .directive('kbnSettingsObjectsView', function (config, Notifier) {
    return {
      restrict: 'E',
      controller: function ($rootScope, $scope, $injector, $routeParams, $location, $window, es, Private, queryEngineClient) {
        var notify = new Notifier({ location: 'SavedObject view' });
        var castMappingType = Private(require('components/index_patterns/_cast_mapping_type'));
        var serviceObj = registry.get($routeParams.service);
        var service = $injector.get(serviceObj.service);

        var dashboardGroupHelper = Private(require('components/kibi/dashboard_group_helper/dashboard_group_helper'));

        /**
         * Creates a field definition and pushes it to the memo stack. This function
         * is designed to be used in conjunction with _.reduce(). If the
         * values is plain object it will recurse through all the keys till it hits
         * a string, number or an array.
         *
         * @param {array} memo The stack of fields
         * @param {mixed} value The value of the field
         * @param {string} key The key of the field
         * @param {object} collection This is a reference the collection being reduced
         * @param {array} parents The parent keys to the field
         * @returns {array}
         */
        var createField = function (memo, val, key, collection, parents) {
          if (_.isArray(parents)) {
            parents.push(key);
          } else {
            parents = [key];
          }

          var field = { type: 'text', name: parents.join('.'), value: val };

          if (_.isString(field.value)) {
            try {
              field.value = angular.toJson(JSON.parse(field.value), true);
              field.type = 'json';
            } catch (err) {
              field.value = field.value;
            }
          } else if (_.isNumeric(field.value)) {
            field.type = 'number';
          } else if (_.isArray(field.value)) {
            field.type = 'array';
            field.value = angular.toJson(field.value, true);
          } else if (_.isBoolean(field.value)) {
            field.type = 'boolean';
            field.value = field.value;
          } else if (_.isPlainObject(field.value)) {
            // do something recursive
            return _.reduce(field.value, _.partialRight(createField, parents), memo);
          }

          memo.push(field);

          // once the field is added to the object you need to pop the parents
          // to remove it since we've hit the end of the branch.
          parents.pop();
          return memo;
        };

        var readObjectClass = function (fields, Class) {
          var fieldMap = _.indexBy(fields, 'name');

          _.forOwn(Class.mapping, function (esType, name) {
            if (fieldMap[name]) return;

            fields.push({
              name: name,
              type: (function () {
                switch (castMappingType(esType)) {
                case 'string': return 'text';
                case 'number': return 'number';
                case 'boolean': return 'boolean';
                default: return 'json';
                }
              }())
            });
          });

          if (Class.searchSource && !fieldMap['kibanaSavedObjectMeta.searchSourceJSON']) {
            fields.push({
              name: 'kibanaSavedObjectMeta.searchSourceJSON',
              type: 'json',
              value: '{}'
            });
          }
        };

        $scope.notFound = $routeParams.notFound;

        $scope.title = inflection.singularize(serviceObj.title);

        es.get({
          index: config.file.kibana_index,
          type: service.type,
          id: $routeParams.id
        })
        .then(function (obj) {
          $scope.obj = obj;
          $scope.link = service.urlFor(obj._id);

          var fields =  _.reduce(obj._source, createField, []);
          if (service.Class) readObjectClass(fields, service.Class);
          $scope.fields = _.sortBy(fields, 'name');
        })
        .catch(notify.fatal);

        // This handles the validation of the Ace Editor. Since we don't have any
        // other hooks into the editors to tell us if the content is valid or not
        // we need to use the annotations to see if they have any errors. If they
        // do then we push the field.name to aceInvalidEditor variable.
        // Otherwise we remove it.
        var loadedEditors = [];
        $scope.aceInvalidEditors = [];

        $scope.aceLoaded = function (editor) {
          if (_.contains(loadedEditors, editor)) return;
          loadedEditors.push(editor);

          var session = editor.getSession();
          var fieldName = editor.container.id;

          session.setTabSize(2);
          session.setUseSoftTabs(true);
          session.on('changeAnnotation', function () {
            var annotations = session.getAnnotations();
            if (_.some(annotations, { type: 'error'})) {
              if (!_.contains($scope.aceInvalidEditors, fieldName)) {
                $scope.aceInvalidEditors.push(fieldName);
              }
            } else {
              $scope.aceInvalidEditors = _.without($scope.aceInvalidEditors, fieldName);
            }
            $rootScope.$$phase || $scope.$apply();
          });
        };

        $scope.cancel = function () {
          $window.history.back();
          return false;
        };

        /**
         * Deletes an object and sets the notification
         * @param {type} name description
         * @returns {type} description
         */
        $scope.delete = function () {

          var _delete = function () {
            es.delete({
              index: config.file.kibana_index,
              type: service.type,
              id: $routeParams.id
            })
            .then(function (resp) {
              $rootScope.$emit('kibi:' + service.type + ':changed', resp);
              return redirectHandler('deleted');
            })
            .catch(notify.fatal);
          };


          // added by sindicetech to prevent deletion of a dashboard which is referenced by dashboardgroup
          if (service.type === 'dashboard') {

            dashboardGroupHelper.getIdsOfDashboardGroupsTheseDashboardsBelongTo([$routeParams.id]).then(function (dashboardGroupNames) {
              if (dashboardGroupNames && dashboardGroupNames.length > 0) {
                var msg =
                  'Dashboard [' + $routeParams.id + '] is reffered by following dashboardGroup' +
                  (dashboardGroupNames.length > 1 ? 's' : '') + ':\n' +
                  dashboardGroupNames.join(', ') + '\n' +
                  'Please edit the group' + (dashboardGroupNames.length > 1 ? 's' : '') +
                  ' and remove the dashboard from its configuration first.';
                $window.alert(msg);
                return;
              } else {
                _delete();
              }
            });

          } else {
            _delete();
          }
          // sindicetech end
        };

        $scope.submit = function () {
          var source = _.cloneDeep($scope.obj._source);

          _.each($scope.fields, function (field) {
            var value = field.value;

            if (field.type === 'number') {
              value = Number(field.value);
            }

            if (field.type === 'array') {
              value = JSON.parse(field.value);
            }

            _.setValue(source, field.name, value);
          });

          es.index({
            index: config.file.kibana_index,
            type: service.type,
            id: $routeParams.id,
            body: source
          })
          .then(function (resp) {

            // added by sindicetech
            // flush the sindicetech cache on the server side
            if (service.type === 'query' || service.type === 'template') {
              queryEngineClient.clearCache().then(function () {
                //console.log('Cache cleared');
              });
            }
            $rootScope.$emit('kibi:' + service.type + ':changed', resp);

            return redirectHandler('updated');
          })
          .catch(notify.fatal);
        };

        function redirectHandler(action) {
          return es.indices.refresh({
            index: config.file.kibana_index
          })
          .then(function (resp) {
            var msg = 'You successfully ' + action + ' the "' + $scope.obj._source.title + '" ' + $scope.title.toLowerCase() + ' object';

            $location.path('/settings/objects').search({
              _a: rison.encode({
                tab: serviceObj.title
              })
            });
            notify.info(msg);
          });
        }

        var sindicetechFields = [
          {name: 'st_activationQuery', size: 1},
          {name: 'st_resultQuery',     size: 4},
          {name: 'st_templateVars',    size: 2}
        ];

        $scope.isItSindicetechField = function (field) {
          var ret = false;
          _.each(sindicetechFields, function (st_field) {
            if (st_field.name === field.name) {
              ret = true;
              return false;
            }
          });
          return ret;
        };
        $scope.computeSindicetechFieldTextareaSize = function (field) {
          var size = 1;
          _.each(sindicetechFields, function (st_field) {
            if (st_field.name === field.name) {
              size = st_field.size;
              return false;
            }
          });
          return size;
        };

      }
    };
  });
});
