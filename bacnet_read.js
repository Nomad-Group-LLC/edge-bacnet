/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/



module.exports = function (RED) {
    const { ReadCommandConfig } = require('./common');
    const baEnum = require('./resources/node-bacnet/index.js').enum;

    function BitpoolBacnetReadDevice (config) {
      RED.nodes.createNode(this, config);
      var node = this;

      this.json = config.json;
      this.mqtt = config.mqtt;
      this.roundDecimal = config.roundDecimal;
      this.pointsToRead = config.pointsToRead;
      this.readDevices = config.readDevices;
      this.id = config.id;

      this.object_property_simplePayload = config.object_property_simplePayload;
      this.object_property_fullObject = config.object_property_fullObject;

      

      this.object_props = getObjectProps(this);

      function getObjectProps(node) {
        var propArr = [];
        if(node.object_property_simplePayload == true){
          propArr.push({ id: baEnum.PropertyIdentifier.PRESENT_VALUE });
        }
        if(node.object_property_fullObject == true){
          propArr.push(
            { id: baEnum.PropertyIdentifier.PRESENT_VALUE },
            { id: baEnum.PropertyIdentifier.DESCRIPTION },
            { id: baEnum.PropertyIdentifier.STATUS_FLAGS },
            { id: baEnum.PropertyIdentifier.RELIABILITY },
            { id: baEnum.PropertyIdentifier.OUT_OF_SERVICE },
            { id: baEnum.PropertyIdentifier.UNITS }
            
            );
        }

        //add object name for every request as its used in formatting
        propArr.push({ id: baEnum.PropertyIdentifier.OBJECT_NAME});

        return propArr;
      };

      var nodeContext = this.context().flow;

      node.on('input', function(msg) {

        let readConfig = new ReadCommandConfig(node.pointsToRead, node.object_props, node.roundDecimal);

        let output = {
          type: "Read",
          id: node.id,
          options: readConfig,
          objectPropertyType: {
            simplePayload: node.object_property_simplePayload,
            fullObject: node.object_property_fullObject
          },
          outputType: {
            json: node.json,
            mqtt: node.mqtt
          }
        };

        node.send(output);

      });

    };

    RED.nodes.registerType('Bacnet-Discovery', BitpoolBacnetReadDevice);
};