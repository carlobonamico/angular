import {Injectable} from 'angular2/src/di/annotations_impl';

import {List, ListWrapper, MapWrapper} from 'angular2/src/facade/collection';
import {isPresent, isBlank} from 'angular2/src/facade/lang';
import {reflector} from 'angular2/src/reflection/reflection';

import {
    ChangeDetection, DirectiveIndex, BindingRecord, DirectiveRecord,
    ProtoChangeDetector, DEFAULT, ChangeDetectorDefinition
} from 'angular2/change_detection';

import * as renderApi from 'angular2/src/render/api';
import {AppProtoView} from './view';
import {ProtoElementInjector, DirectiveBinding} from './element_injector';

class BindingRecordsCreator {
  _directiveRecordsMap;
  _textNodeIndex:number;

  constructor() {
    this._directiveRecordsMap = MapWrapper.create();
    this._textNodeIndex = 0;
  }

  getBindingRecords(elementBinders:List<renderApi.ElementBinder>,
      allDirectiveMetadatas:List<renderApi.DirectiveMetadata>
      ):List<BindingRecord> {
    var bindings = [];

    for (var boundElementIndex = 0; boundElementIndex < elementBinders.length; boundElementIndex++) {
      var renderElementBinder = elementBinders[boundElementIndex];
      bindings = ListWrapper.concat(bindings, this._createTextNodeRecords(renderElementBinder));
      bindings = ListWrapper.concat(bindings, this._createElementPropertyRecords(boundElementIndex, renderElementBinder));
      bindings = ListWrapper.concat(bindings, this._createDirectiveRecords(boundElementIndex,
        renderElementBinder.directives, allDirectiveMetadatas));
    }

    return bindings;
  }

  getDirectiveRecords(
      elementBinders:List<renderApi.ElementBinder>,
      allDirectiveMetadatas:List<renderApi.DirectiveMetadata>): List<DirectiveRecord> {
    var directiveRecords = [];

    for (var elementIndex = 0; elementIndex < elementBinders.length; ++elementIndex) {
      var dirs = elementBinders[elementIndex].directives;
      for (var dirIndex = 0; dirIndex < dirs.length; ++dirIndex) {
        ListWrapper.push(directiveRecords, this._getDirectiveRecord(elementIndex, dirIndex, allDirectiveMetadatas[dirs[dirIndex].directiveIndex]));
      }
    }

    return directiveRecords;
  }

  _createTextNodeRecords(renderElementBinder:renderApi.ElementBinder) {
    if (isBlank(renderElementBinder.textBindings)) return [];
    return ListWrapper.map(renderElementBinder.textBindings, b => BindingRecord.createForTextNode(b, this._textNodeIndex++));
  }

  _createElementPropertyRecords(boundElementIndex:number, renderElementBinder:renderApi.ElementBinder) {
    var res = [];
    MapWrapper.forEach(renderElementBinder.propertyBindings, (astWithSource, propertyName) => {
      ListWrapper.push(res, BindingRecord.createForElement(astWithSource, boundElementIndex, propertyName));
    });
    return res;
  }

  _createDirectiveRecords(boundElementIndex:number, directiveBinders:List<renderApi.DirectiveBinder>,
      allDirectiveMetadatas:List<renderApi.DirectiveMetadata>) {
    var res = [];
    for (var i = 0; i < directiveBinders.length; i++) {
      var directiveBinder = directiveBinders[i];
      var directiveMetadata = allDirectiveMetadatas[directiveBinder.directiveIndex];

      // directive properties
      MapWrapper.forEach(directiveBinder.propertyBindings, (astWithSource, propertyName) => {
        // TODO: these setters should eventually be created by change detection, to make
        // it monomorphic!
        var setter = reflector.setter(propertyName);
        var directiveRecord = this._getDirectiveRecord(boundElementIndex, i, directiveMetadata);
        var b = BindingRecord.createForDirective(astWithSource, propertyName, setter, directiveRecord);
        ListWrapper.push(res, b);
      });

      // host properties
      MapWrapper.forEach(directiveBinder.hostPropertyBindings, (astWithSource, propertyName) => {
        var dirIndex = new DirectiveIndex(boundElementIndex, i);
        var b = BindingRecord.createForHostProperty(dirIndex, astWithSource, propertyName);
        ListWrapper.push(res, b);
      });
    }
    return res;
  }

  _getDirectiveRecord(boundElementIndex:number, directiveIndex:number, directiveMetadata:renderApi.DirectiveMetadata): DirectiveRecord {
    var id = boundElementIndex * 100 + directiveIndex;

    if (!MapWrapper.contains(this._directiveRecordsMap, id)) {
      var changeDetection = directiveMetadata.changeDetection;

      MapWrapper.set(this._directiveRecordsMap, id,
        new DirectiveRecord(new DirectiveIndex(boundElementIndex, directiveIndex),
          directiveMetadata.callOnAllChangesDone, directiveMetadata.callOnChange, changeDetection));
    }

    return MapWrapper.get(this._directiveRecordsMap, id);
  }
}

@Injectable()
export class ProtoViewFactory {
  _changeDetection:ChangeDetection;

  constructor(changeDetection:ChangeDetection) {
    this._changeDetection = changeDetection;
  }

  /**
   * Returns the data needed to create ChangeDetectors
   * for the given ProtoView and all nested ProtoViews.
   */
  getChangeDetectorDefinitions(hostComponentMetadata:renderApi.DirectiveMetadata,
      rootRenderProtoView: renderApi.ProtoViewDto, allRenderDirectiveMetadata:List<renderApi.DirectiveMetadata>):List<ChangeDetectorDefinition> {
    var nestedPvsWithIndex = this._collectNestedProtoViews(rootRenderProtoView);
    var nestedPvVariableBindings = this._collectNestedProtoViewsVariableBindings(nestedPvsWithIndex);
    var nestedPvVariableNames = this._collectNestedProtoViewsVariableNames(nestedPvsWithIndex, nestedPvVariableBindings);

    return this._getChangeDetectorDefinitions(
      hostComponentMetadata,
      nestedPvsWithIndex,
      nestedPvVariableNames,
      allRenderDirectiveMetadata
    );
  }

  createAppProtoViews(hostComponentBinding:DirectiveBinding,
                  rootRenderProtoView: renderApi.ProtoViewDto, allDirectives:List<DirectiveBinding>):List<AppProtoView> {
    var allRenderDirectiveMetadata = ListWrapper.map(allDirectives, directiveBinding => directiveBinding.metadata );
    var nestedPvsWithIndex = this._collectNestedProtoViews(rootRenderProtoView);
    var nestedPvVariableBindings = this._collectNestedProtoViewsVariableBindings(nestedPvsWithIndex);
    var nestedPvVariableNames = this._collectNestedProtoViewsVariableNames(nestedPvsWithIndex, nestedPvVariableBindings);
    var changeDetectorDefs = this._getChangeDetectorDefinitions(
        hostComponentBinding.metadata, nestedPvsWithIndex, nestedPvVariableNames, allRenderDirectiveMetadata
    );
    var protoChangeDetectors = ListWrapper.map(
        changeDetectorDefs, changeDetectorDef => this._changeDetection.createProtoChangeDetector(changeDetectorDef)
    );
    var appProtoViews = ListWrapper.createFixedSize(nestedPvsWithIndex.length);
    ListWrapper.forEach(nestedPvsWithIndex, (pvWithIndex) => {
      var appProtoView = this._createAppProtoView(
        pvWithIndex.renderProtoView,
        protoChangeDetectors[pvWithIndex.index],
        nestedPvVariableBindings[pvWithIndex.index],
        allDirectives
      );
      if (isPresent(pvWithIndex.parentIndex)) {
        var parentView = appProtoViews[pvWithIndex.parentIndex];
        parentView.elementBinders[pvWithIndex.boundElementIndex].nestedProtoView = appProtoView;
      }
      appProtoViews[pvWithIndex.index] = appProtoView;
    });
    return appProtoViews;
  }

  _collectNestedProtoViews(renderProtoView:renderApi.ProtoViewDto, parentIndex:number = null, boundElementIndex = null, result:List<RenderProtoViewWithIndex> = null):List<RenderProtoViewWithIndex> {
    if (isBlank(result)) {
      result = [];
    }
    ListWrapper.push(result, new RenderProtoViewWithIndex(renderProtoView, result.length, parentIndex, boundElementIndex));
    var currentIndex = result.length - 1;
    var childBoundElementIndex = 0;
    ListWrapper.forEach(renderProtoView.elementBinders, (elementBinder) => {
      if (isPresent(elementBinder.nestedProtoView)) {
        this._collectNestedProtoViews(elementBinder.nestedProtoView, currentIndex, childBoundElementIndex, result);
      }
      childBoundElementIndex++;
    });
    return result;
  }

  _getChangeDetectorDefinitions(
      hostComponentMetadata:renderApi.DirectiveMetadata,
      nestedPvsWithIndex: List<RenderProtoViewWithIndex>,
      nestedPvVariableNames: List<List<string>>,
      allRenderDirectiveMetadata:List<renderApi.DirectiveMetadata>):List<ChangeDetectorDefinition> {
    return ListWrapper.map(nestedPvsWithIndex, (pvWithIndex) => {
      var elementBinders = pvWithIndex.renderProtoView.elementBinders;
      var bindingRecordsCreator = new BindingRecordsCreator();
      var bindingRecords = bindingRecordsCreator.getBindingRecords(elementBinders, allRenderDirectiveMetadata);
      var directiveRecords = bindingRecordsCreator.getDirectiveRecords(elementBinders, allRenderDirectiveMetadata);
      var strategyName = DEFAULT;
      var typeString;
      if (pvWithIndex.renderProtoView.type === renderApi.ProtoViewDto.COMPONENT_VIEW_TYPE) {
        strategyName = hostComponentMetadata.changeDetection;
        typeString = 'comp';
      } else if (pvWithIndex.renderProtoView.type === renderApi.ProtoViewDto.HOST_VIEW_TYPE) {
        typeString = 'host';
      } else {
        typeString = 'embedded';
      }
      var id = `${hostComponentMetadata.id}_${typeString}_${pvWithIndex.index}`;
      var variableNames = nestedPvVariableNames[pvWithIndex.index];
      return new ChangeDetectorDefinition(id, strategyName, variableNames, bindingRecords, directiveRecords);
    });
  }

  _createAppProtoView(
      renderProtoView: renderApi.ProtoViewDto,
      protoChangeDetector: ProtoChangeDetector,
      variableBindings: Map<string, string>,
      allDirectives:List<DirectiveBinding>
      ):AppProtoView {
    var elementBinders = renderProtoView.elementBinders;
    var protoView = new AppProtoView(renderProtoView.render, protoChangeDetector, variableBindings);

    // TODO: vsavkin refactor to pass element binders into proto view
    this._createElementBinders(protoView, elementBinders, allDirectives);
    this._bindDirectiveEvents(protoView, elementBinders);

    return protoView;
  }

  _collectNestedProtoViewsVariableBindings(
      nestedPvsWithIndex: List<RenderProtoViewWithIndex>
    ):List<Map<string, string>> {
    return ListWrapper.map(nestedPvsWithIndex, (pvWithIndex) => {
      return this._createVariableBindings(pvWithIndex.renderProtoView);
    });
  }

  _createVariableBindings(renderProtoView):Map {
    var variableBindings = MapWrapper.create();
    MapWrapper.forEach(renderProtoView.variableBindings, (mappedName, varName) => {
      MapWrapper.set(variableBindings, varName, mappedName);
    });
    ListWrapper.forEach(renderProtoView.elementBinders, binder => {
      MapWrapper.forEach(binder.variableBindings, (mappedName, varName) => {
        MapWrapper.set(variableBindings, varName, mappedName);
      });
    });
    return variableBindings;
  }

  _collectNestedProtoViewsVariableNames(
      nestedPvsWithIndex: List<RenderProtoViewWithIndex>,
      nestedPvVariableBindings:List<Map<string, string>>
    ):List<List<string>> {
    var nestedPvVariableNames = ListWrapper.createFixedSize(nestedPvsWithIndex.length);
    ListWrapper.forEach(nestedPvsWithIndex, (pvWithIndex) => {
      var parentVariableNames = isPresent(pvWithIndex.parentIndex) ? nestedPvVariableNames[pvWithIndex.parentIndex] : null;
      nestedPvVariableNames[pvWithIndex.index] = this._createVariableNames(
        parentVariableNames, nestedPvVariableBindings[pvWithIndex.index]
      );
    });
    return nestedPvVariableNames;
  }

  _createVariableNames(parentVariableNames, variableBindings):List {
    var variableNames = isPresent(parentVariableNames) ? ListWrapper.clone(parentVariableNames) : [];
    MapWrapper.forEach(variableBindings, (local, v) => {
      ListWrapper.push(variableNames, local);
    });
    return variableNames;
  }

  _createElementBinders(protoView, elementBinders, allDirectiveBindings) {
    for (var i=0; i<elementBinders.length; i++) {
      var renderElementBinder = elementBinders[i];
      var dirs = elementBinders[i].directives;

      var parentPeiWithDistance = this._findParentProtoElementInjectorWithDistance(
          i, protoView.elementBinders, elementBinders);
      var directiveBindings = ListWrapper.map(dirs, (dir) => allDirectiveBindings[dir.directiveIndex] );
      var componentDirectiveBinding = null;
      if (directiveBindings.length > 0) {
        if (directiveBindings[0].metadata.type === renderApi.DirectiveMetadata.COMPONENT_TYPE) {
          componentDirectiveBinding = directiveBindings[0];
        }
      }
      var protoElementInjector = this._createProtoElementInjector(
          i, parentPeiWithDistance, renderElementBinder, componentDirectiveBinding, directiveBindings);

      this._createElementBinder(protoView, i, renderElementBinder, protoElementInjector, componentDirectiveBinding);
    }
  }

  _findParentProtoElementInjectorWithDistance(binderIndex, elementBinders, renderElementBinders) {
    var distance = 0;
    do {
      var renderElementBinder = renderElementBinders[binderIndex];
      binderIndex = renderElementBinder.parentIndex;
      if (binderIndex !== -1) {
        distance += renderElementBinder.distanceToParent;
        var elementBinder = elementBinders[binderIndex];
        if (isPresent(elementBinder.protoElementInjector)) {
          return new ParentProtoElementInjectorWithDistance(elementBinder.protoElementInjector, distance);
        }
      }
    } while (binderIndex !== -1);
    return new ParentProtoElementInjectorWithDistance(null, -1);
  }

  _createProtoElementInjector(binderIndex, parentPeiWithDistance, renderElementBinder, componentDirectiveBinding, directiveBindings) {
    var protoElementInjector = null;
    // Create a protoElementInjector for any element that either has bindings *or* has one
    // or more var- defined. Elements with a var- defined need a their own element injector
    // so that, when hydrating, $implicit can be set to the element.
    var hasVariables = MapWrapper.size(renderElementBinder.variableBindings) > 0;
    if (directiveBindings.length > 0 || hasVariables) {
      protoElementInjector = new ProtoElementInjector(
          parentPeiWithDistance.protoElementInjector, binderIndex,
          directiveBindings,
          isPresent(componentDirectiveBinding), parentPeiWithDistance.distance
      );
      protoElementInjector.attributes = renderElementBinder.readAttributes;
      if (hasVariables) {
        protoElementInjector.exportComponent = isPresent(componentDirectiveBinding);
        protoElementInjector.exportElement = isBlank(componentDirectiveBinding);

        // experiment
        var exportImplicitName = MapWrapper.get(renderElementBinder.variableBindings, '\$implicit');
        if (isPresent(exportImplicitName)) {
          protoElementInjector.exportImplicitName = exportImplicitName;
        }
      }
    }
    return protoElementInjector;
  }

  _createElementBinder(protoView, boundElementIndex, renderElementBinder, protoElementInjector, componentDirectiveBinding) {
    var parent = null;
    if (renderElementBinder.parentIndex !== -1) {
      parent = protoView.elementBinders[renderElementBinder.parentIndex];
    }
    var elBinder = protoView.bindElement(
      parent,
      renderElementBinder.distanceToParent,
      protoElementInjector,
      componentDirectiveBinding
    );
    protoView.bindEvent(renderElementBinder.eventBindings, boundElementIndex, -1);
    // variables
    // The view's locals needs to have a full set of variable names at construction time
    // in order to prevent new variables from being set later in the lifecycle. Since we don't want
    // to actually create variable bindings for the $implicit bindings, add to the
    // protoLocals manually.
    MapWrapper.forEach(renderElementBinder.variableBindings, (mappedName, varName) => {
      MapWrapper.set(protoView.protoLocals, mappedName, null);
    });
    return elBinder;
  }

  _bindDirectiveEvents(protoView, elementBinders:List<renderApi.ElementBinder>) {
    for (var boundElementIndex = 0; boundElementIndex < elementBinders.length; ++boundElementIndex) {
      var dirs = elementBinders[boundElementIndex].directives;
      for (var i = 0; i < dirs.length; i++) {
        var directiveBinder = dirs[i];

        // directive events
        protoView.bindEvent(directiveBinder.eventBindings, boundElementIndex, i);
      }
    }
  }
}

class RenderProtoViewWithIndex {
  renderProtoView:renderApi.ProtoViewDto;
  index:number;
  parentIndex:number;
  boundElementIndex:number;
  constructor(renderProtoView:renderApi.ProtoViewDto, index:number, parentIndex:number, boundElementIndex:number) {
    this.renderProtoView = renderProtoView;
    this.index = index;
    this.parentIndex = parentIndex;
    this.boundElementIndex = boundElementIndex;
  }
}

class ParentProtoElementInjectorWithDistance {
  protoElementInjector:ProtoElementInjector;
  distance:number;
  constructor(protoElementInjector:ProtoElementInjector, distance:number) {
    this.protoElementInjector = protoElementInjector;
    this.distance = distance;
  }
}
