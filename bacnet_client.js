/*
  MIT License Copyright 2021, 2022 - Bitpool Pty Ltd
*/

const bacnet = require('./resources/node-bacstack-ts/dist/index.js');
const baEnum = bacnet.enum;
const bacnetIdMax = baEnum.ASN1_MAX_PROPERTY_ID;
const { EventEmitter } = require('events');
const { getUnit, roundDecimalPlaces, Store_Config, Read_Config_Sync } = require('./common');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { BacnetDevice } = require('./bacnet_device');
const {Mutex} = require("async-mutex");

class BacnetClient extends EventEmitter {

    //client constructor
    constructor(config) {
        super();
        let that = this;
        that.deviceList = [];
        that.manualDiscoverQueue = [];
        that.networkTree = {};
        that.lastWhoIs = null;
        that.client = null;
        that.lastNetworkPoll = null;
        that.scheduler = new ToadScheduler();
        that.mutex = new Mutex();
        that.manualMutex = new Mutex();
        that.pollInProgress = false;
        that.scanMatrix = [];

        try {

            let cachedData = JSON.parse(Read_Config_Sync());
            if(cachedData && typeof cachedData == "object") {
                if(cachedData.renderList) that.renderList = cachedData.renderList;
                if(cachedData.deviceList) {
                    cachedData.deviceList.forEach(function(device) {
                        let newBacnetDevice = new BacnetDevice(true, device);
                        that.deviceList.push(newBacnetDevice);
                    });
                }
                if(cachedData.pointList) that.networkTree = cachedData.pointList;
            }
            
            

            that.config = config;
            that.roundDecimal = config.roundDecimal;
            that.apduSize = config.apduSize;
            that.maxSegments = config.maxSegments;
            that.discover_polling_schedule = config.discover_polling_schedule;
            that.deviceId = config.deviceId;
            that.broadCastAddr = config.broadCastAddr;
            that.manual_instance_range_enabled = config.manual_instance_range_enabled;
            that.manual_instance_range_start = config.manual_instance_range_start;
            that.manual_instance_range_end = config.manual_instance_range_end;
            that.device_read_schedule = config.device_read_schedule;
            that.deviceRetryCount = parseInt(config.retries);

            that.readPropertyMultipleOptions = {
                maxSegments: that.maxSegments,
                maxApdu: that.apduSize
            };

            

            try {
                
                that.client = new bacnet.Client({ apduTimeout: config.apduTimeout, interface: config.localIpAdrress, port: config.port, broadcastAddress: config.broadCastAddr});
                that.setMaxListeners(1);

                const task = new Task('simple task', () => {
                    that.globalWhoIs(); 
                });

                const job = new SimpleIntervalJob({ seconds: parseInt(that.discover_polling_schedule), }, task)
                
                that.scheduler.addSimpleIntervalJob(job);

                //query device task
                const queryDevices = new Task('simple task', () => {
                    if(!that.pollInProgress) that.queryDevices(); 
                    that.sanitizeDeviceList();
                });

                const queryJob = new SimpleIntervalJob({ seconds: parseInt(that.device_read_schedule), }, queryDevices)
                
                that.scheduler.addSimpleIntervalJob(queryJob);

                //buildNetworkTreeData task
                const buildNetworkTree = new Task('simple task', () => {
                    that.buildNetworkTreeData();
                });

                const buildNetworkTreeJob = new SimpleIntervalJob({ seconds: 10, }, buildNetworkTree)
                
                that.scheduler.addSimpleIntervalJob(buildNetworkTreeJob);

                that.globalWhoIs();

                setTimeout(() => {
                    that.queryDevices();
                    that.sanitizeDeviceList();
                    that.buildNetworkTreeData();
                  }, "5000")

            } catch(e) {
                that.logOut("Issue initializing client: ", e)
            }

            //who is callback
            that.client.on('iAm', (device) => {
                if(device.address !== that.config.localIpAdrress) {
                    if(that.scanMatrix.length > 0) {
                        let matrixMap = that.scanMatrix.filter(ele => device.deviceId >= ele.start && device.deviceId <= ele.end);
                        if(matrixMap.length > 0) {
                            //only add unique device to array
                            let foundIndex = that.deviceList.findIndex(ele => ele.getDeviceId() == device.deviceId);
                            if(foundIndex == -1) {
                                let newBacnetDevice = new BacnetDevice(false, device);
                                newBacnetDevice.setLastSeen(Date.now());
                                that.updateDeviceName(newBacnetDevice);
                                that.deviceList.push(newBacnetDevice);

                            } else if(foundIndex !== -1) {
                                that.deviceList[foundIndex].updateDeviceConfig(device);
                                that.deviceList[foundIndex].setLastSeen(Date.now());
                                that.updateDeviceName(that.deviceList[foundIndex]);
                            }
                            
                            //emit event for node-red to log 
                            that.emit('deviceFound', device);
                        }
                    } else {
                        //only add unique device to array
                        let foundIndex = that.deviceList.findIndex(ele => ele.getDeviceId() == device.deviceId);
                        if(foundIndex == -1) {
                            let newBacnetDevice = new BacnetDevice(false, device);
                            newBacnetDevice.setLastSeen(Date.now());
                            that.updateDeviceName(newBacnetDevice);
                            that.deviceList.push(newBacnetDevice);
                        } else if(foundIndex !== -1) {
                            that.deviceList[foundIndex].updateDeviceConfig(device);
                            that.deviceList[foundIndex].setLastSeen(Date.now());
                            that.updateDeviceName(that.deviceList[foundIndex]);
                        }
                        
                        //emit event for node-red to log 
                        that.emit('deviceFound', device);
                    }
                }
            });

        } catch(e) {
            that.logOut("Issue with creating bacnet client, see error:  ", e);
        }

        that.client.on('error', (err) => {
            that.logOut('Error occurred: ', err);

            if(err.errno == -4090){
                that.logOut("Invalid Client information or incorrect IP address provided");
            } else if(err.errno == -49) {
                that.logOut("Invalid IP address provided");
            } else {
                that.reinitializeClient(that.config);
            }
        });
        
    }

    logOut(param1, param2) {
        let that = this;
        that.emit('bacnetErrorLog', param1, param2);
    }

    rebuildDataModel() {
        let that = this;
        return new Promise((resolve, reject) => {
            try {
                that.deviceList = [];
                that.renderList = [];
                that.networkTree = {};
                that.pollInProgress = false;
                resolve(true);
            } catch(e) {
                that.logOut("Error clearing BACnet data model: ", e);
                reject(e);
            }
        });
    }

    queryDevices() {
        let that = this;

        that.pollInProgress = true;

        let index = 0;

        query(index);

        function query(index) {
            that.queryPriorityDevices().then(function() {

                let device = that.deviceList[index];

                if(index < that.deviceList.length) {
                    index++;
                
                    if(typeof device == "object") {
                        if(!device.getManualDiscoveryMode()) {
                            try {
                                that.getDevicePointList(device).then(function() {
                                    that.removeDeviceFromManualQueue(device);
                                    that.buildJsonObject(device, null).then(function() {
                                        query(index);
                                    }).catch(function(e) {
                                        that.logOut(`getDevicePointList error: ${device.getAddress()}`, e);
                                        query(index);
                                    });
                                }).catch(function(e) {
                                    that.logOut(`getDevicePointList error: ${device.getAddress()}`, e);
                                    that.addDeviceToManualQueue(device);
                                    query(index);
                                });
                            } catch(e) {
                                that.logOut("Error while querying devices: ", e);
                                query(index);
                            }
                        } else {
                            query(index);
                        }
                    } else {
                        that.logOut("queryDevices: invalid device found: ", device);
                        query(index);
                    }
                } else if(index == that.deviceList.length) {

                    if(that.manualDiscoverQueue.length > 0) {
                        that.queryDevicesManually();
                    } else {
                        that.pollInProgress = false;
                    }
                    
                }
            });
        }
    }

    queryDevicesManually() {
        let that = this;
        let index = 0;
        query(index);

        function query(index) {
            that.queryPriorityDevices().then(function() {
                let device = that.manualDiscoverQueue[index];
                if(index < that.manualDiscoverQueue.length) {
                    index++;
                    if(typeof device == "object") {
                        try {
                            if(device.shouldBeInManualMode()) {
                                that.getDevicePointListWithoutObjectList(device).then(function() {
                                    that.buildJsonObject(device, null).then(function() {
                                        query(index);
                                    }).catch(function(e) {
                                        that.logOut(`getDevicePointList error: ${device.getAddress()}`, e);
                                        query(index);
                                    });
                                }).catch(function(e){
                                    query(index);
                                });
                            } else {
                                that.removeDeviceFromManualQueue(device);
                                query(index);
                            }
                        } catch(e) {
                            query(index);
                        }
                    } else {
                        query(index);
                    }
                } else if(index == that.manualDiscoverQueue.length) {
                    that.pollInProgress = false;
                }
            });
        }
    }

    queryPriorityDevices() {
        let that = this;
        return new Promise((resolve, reject) => {
            let priorityDevices = that.getPriorityDevices();

            if(priorityDevices.length > 0) {
                let index = 0;

                query(index);
        
                function query(index) {
                    let device = priorityDevices[index];
        
                    if(index < priorityDevices.length) {
                        index++;
                    
                        if(typeof device == "object" && ((Date.now() - device.getLastPriorityQueueTS()) / 1000) > parseInt(that.device_read_schedule) ) {
                            
                            try {
                                let points = device.getPriorityQueue();
                                that.buildJsonObject(device, points).then(function() {
                                    device.setLastPriorityQueueTS();
                                    query(index);
                                }).catch(function(e) {
                                    that.logOut(`queryPriorityDevices error: ${device.getAddress()}`, e);
                                    query(index);
                                });
                                
                            } catch(e) {
                                that.logOut("Error while querying priority devices: ", e);
                                query(index);
                            }
                            
                        } else {
                            query(index);
                        }
                    } else if(index == priorityDevices.length) {
                        resolve()
                    }
                }
            } else if(priorityDevices.length == 0) {
                resolve()
            }
        });
    }

    addDeviceToManualQueue(device) {
        let that = this;

        if(device.getPointListRetryCount() > that.deviceRetryCount) {
            device.setManualDiscoveryMode(true);
            let index = that.manualDiscoverQueue.findIndex(ele => ele.getDeviceId() == device.getDeviceId());
            if(index == -1) {
                that.manualDiscoverQueue.push(device);  
            }
        } else {
            device.incrementPointListRetryCount();
        }
    }

    removeDeviceFromManualQueue(device) {
        let that = this;
        device.setManualDiscoveryMode(false);
        device.clearPointListRetryCount()
        let index = that.manualDiscoverQueue.findIndex(ele => ele.getDeviceId() == device.getDeviceId());
        if(index !== -1) {
            that.manualDiscoverQueue.splice(index, 1);  
        }
    }

    sanitizeDeviceList() {
        let that = this;
        
        //Discover frequencey x 2
        let timeoutThreshold = parseInt(that.discover_polling_schedule) * 2;

        that.deviceList.forEach(function(device, index) {
            if(((Date.now() - device.getLastSeen()) / 1000) > timeoutThreshold && device.getPriorityQueueIsActive() == false) {
                //render device hasnt responded to whoIs for disover frequency x 2

                let renderListIndex = that.renderList.findIndex(ele => ele.deviceId == device.getDeviceId());

                let ipAddr = typeof device.getAddress() == "object" ? device.getAddress().address : device.getAddress();
                let deviceKey = ipAddr + "-" + device.getDeviceId();            

                delete that.networkTree[deviceKey];

                that.renderList.splice(renderListIndex, 1);

                that.deviceList.splice(index, 1);
            }
        });
        
    }

    updateDeviceName(device) {
        let that = this;
        that._getDeviceName(device.getAddress(), device.getDeviceId()).then(function(deviceObject) {
            if(typeof deviceObject.name == "string") {
                device.setDeviceName(deviceObject.name);
                device.setPointsList(deviceObject.devicePointEntry);
            }
        });
    }

    reinitializeClient(config) {
        let that = this;

        that.config = config;
        that.roundDecimal = config.roundDecimal;
        that.apduSize = config.apduSize;
        that.maxSegments = config.maxSegments;
        that.discover_polling_schedule = config.discover_polling_schedule;
        that.deviceId = config.deviceId;
        that.broadCastAddr = config.broadCastAddr;
        that.manual_instance_range_enabled = config.manual_instance_range_enabled;
        that.manual_instance_range_start = config.manual_instance_range_start;
        that.manual_instance_range_end = config.manual_instance_range_end;
        that.device_read_schedule = config.device_read_schedule;

        if(that.scheduler !== null) {
            that.scheduler.stop();
        }

        try {
            that.client._settings.apduTimeout = config.apduTimeout;
            that.client._settings.interface = config.localIpAdrress;
            that.client._settings.port = config.port;
            that.client._settings.broadcastAddress = config.broadCastAddr;

            that.client._transport.interface = config.localIpAdrress;
            that.client._transport.port = config.port;
            that.client._transport.broadcastAddress = config.broadCastAddr;

            const task = new Task('simple task', () => { 
                that.globalWhoIs(); 
            });

            const job = new SimpleIntervalJob({ seconds: parseInt(config.discover_polling_schedule), }, task)
            
            that.scheduler.addSimpleIntervalJob(job);


            // //query device task
            const queryDevices = new Task('simple task', () => {
                if(!that.pollInProgress) that.queryDevices(); 
                that.sanitizeDeviceList();
            });

            const queryJob = new SimpleIntervalJob({ seconds: parseInt(config.device_read_schedule), }, queryDevices)
            
            that.scheduler.addSimpleIntervalJob(queryJob);

            //buildNetworkTreeData task
            const buildNetworkTree = new Task('simple task', () => {
                that.buildNetworkTreeData();
            });

            const buildNetworkTreeJob = new SimpleIntervalJob({ seconds: 10, }, buildNetworkTree)
            
            that.scheduler.addSimpleIntervalJob(buildNetworkTreeJob);

        } catch(e){
            that.logOut("Error reinitializing bacnet client: ", e)
        }
    };

    getValidPointProperties(point, requestedProps) {
        let that = this;
        let availableProps = point.propertyList;
        let newProps = [];

        try{
            requestedProps.forEach(function(prop) {
                let foundInAvailable = availableProps.find(ele => ele === prop.id);
                if(foundInAvailable) newProps.push(prop);
            });
            //add object name for use in formatting
            newProps.push({id: baEnum.PropertyIdentifier.OBJECT_NAME});
        } catch(e){
            that.logOut("Issue finding valid object properties, see error: ", e);
        }

        return newProps;
    }

    doRead(readConfig, outputType, objectPropertyType, msgId) {
        let that = this;
        that.roundDecimal = readConfig.precision;
        let devicesToRead = Object.keys(readConfig.pointsToRead);

        try {
            let bacnetResults = {};
            devicesToRead.forEach(function(key, index) {
                let device = that.deviceList.find(ele => `${that.getDeviceAddress(ele)}-${ele.getDeviceId()}` == key);
                if(device) {
                    let deviceName = device.getDeviceName();
                    let deviceKey = (typeof device.getAddress() == "object") ? device.getAddress().address + "-" + device.getDeviceId() : device.getAddress() + "-" + device.getDeviceId();            
                    let deviceObject = that.networkTree[deviceKey];
                    if(!bacnetResults[deviceName]) bacnetResults[deviceName] = {};
                    if(deviceObject) {
                        for(const pointName in readConfig.pointsToRead[key]) {
                            let bac_obj = that.getObjectType(readConfig.pointsToRead[key][pointName].meta.objectId.type);
                            let objectId = pointName + "_" + bac_obj + '_' + readConfig.pointsToRead[key][pointName].meta.objectId.instance;
                            let point = deviceObject[objectId];
                            bacnetResults[deviceName][pointName] = point;
                        }
                    }
                }

                if(index == devicesToRead.length - 1 && Object.keys(readConfig.pointsToRead).length > 0) that.emit('values', bacnetResults, outputType, objectPropertyType);
            });
        } catch(e) {
            that.logOut("Issue doing read, see error: ", e);
        }
    }

    getDeviceAddress(device) {
        switch(typeof device.getAddress()) {
            case "object":
                return device.getAddress().address;
            case "string":
                return device.getAddress();
            default:    
                return device.getAddress();
        }
    }

    _getDeviceName(address, deviceId) {
        let that = this;
        return new Promise((resolve, reject) => {
            that._readDeviceName(address, deviceId, (err, result) => {
                if(result) {
                    try {
                        if(result.values[0].value) {
                            const deviceObject = {
                                name: result.values[0].value,
                                devicePointEntry: [{ value: { type: 8, instance: deviceId }, type: 12 }]
                            };
                            resolve(deviceObject);
                        } else {
                            that.logOut("Issue with deviceName payload, see object: ", object);
                        }
                    } catch(e){
                       that.logOut("Unable to get device name: ", e);
                    }
                }
            });
        });
    }

    getPropertiesForType(props, type) {
        let that = this;
        let newProps = [];
        props.forEach(function(prop) {
            //that.logOut(prop);
            switch(type){
                case 0:  //analog-input
                    newProps.push(prop);
                    break;
                case 1: //analog-output
                    newProps.push(prop);
                    break;
                case 2: //analog-value
                    newProps.push(prop);
                    break;
                case 3: //binary-input
                    newProps.push(prop);
                    break;
                case 4: //binary-output
                    newProps.push(prop);
                    break;
                case 5: //binary-value
                    newProps.push(prop);
                    break;
                case 13:
                    if(prop.id == baEnum.PropertyIdentifier.PRESENT_VALUE || prop.id == baEnum.PropertyIdentifier.OBJECT_NAME) newProps.push(prop);
                    break;     
                case 14:
                    if(prop.id == baEnum.PropertyIdentifier.PRESENT_VALUE || prop.id == baEnum.PropertyIdentifier.OBJECT_NAME) newProps.push(prop);
                    break;   
                case 19:
                    if(prop.id == baEnum.PropertyIdentifier.PRESENT_VALUE || prop.id == baEnum.PropertyIdentifier.OBJECT_NAME) newProps.push(prop);
                    break;              
            }
        });
        return newProps;
    }

    getDevicePointList(device) {
        let that = this;
        return new Promise(async function(resolve, reject) {
            try {
                device.setManualDiscoveryMode(false);
                let result = await that.scanDevice(device);
                device.setPointsList(result);
                resolve(result);
            } catch(e) {
                that.logOut(`Error getting point list for ${device.getAddress().toString()} - ${device.getDeviceId()}: `, e);
                reject(e);
            }
        });
    }

    getDevicePointListWithoutObjectList(device) {
        let that = this;
        return new Promise(function(resolve, reject) {
            try {
                that.scanDeviceManually(device).then(function(result) {
                    device.setPointsList(result);
                    resolve(result);
                }).catch(function(error) {
                    reject(error);
                });

            } catch(e) {
                that.logOut("Error getting point list: ", e);
                reject(e);
            }
            
        });
    }

    scanDeviceManually(device) {
        let that = this;

        return new Promise(function(resolve, reject) {
    
            let objectNameProperty = [{ id: baEnum.PropertyIdentifier.OBJECT_NAME }];
            let address = device.getAddress();
            let objectTypeList = [0, 1, 2, 3, 4, 5, 13, 14, 19];
            //let objectTypeList = [0, 1, 2, 3, 4, 5, 6, 10, 13, 14, 15, 16, 17, ,19, 20, 56, 178];
            //let instanceRange = {start: 0, end: 100};
            let instanceRange = device.getmDiscoverInstanceRange();
            let requestArray = [];
            let maxRequestThreshold = 1000;
            let requestRate = 20;
            let requestBuffer = [];
            let sendBuffer = [];

            if(that.manual_instance_range_enabled == true) {
                instanceRange.start = that.manual_instance_range_start;
                maxRequestThreshold = that.manual_instance_range_end;
                if(that.manual_instance_range_end < requestRate) {
                    requestRate = that.manual_instance_range_end;
                }
            }

            for(let typeListIndex = 0; typeListIndex < objectTypeList.length; typeListIndex++){
                let objectType = objectTypeList[typeListIndex];
                for(let i = instanceRange.start; i <= instanceRange.end; i++) {

                    requestArray.push({
                        objectId: { type: objectType, instance: i },
                        properties: objectNameProperty
                    })

                    if(requestArray.length == requestRate ) {
                        requestBuffer.push(that._readObjectWithRequestArray(address, requestArray));
                        instanceRange.end += requestRate;
                        requestArray = [];
                        if(i >= maxRequestThreshold) {
                            if(typeListIndex == objectTypeList.length-1) {
                                device.setmDiscoverInstanceRange({start: instanceRange.end, end: instanceRange.end + 100})
                                send();
                            }
                            
                            break;
                        }
                    }
                }

            };

            function send() {

                for(let index = 0; index < requestBuffer.length; index++) {
                    let promise = requestBuffer[index];
                    try {
                        Promise.resolve(promise).then(function(result) {
                            for (const [key, value] of Object.entries(result)) {
                                if(key == "value" && typeof value == "object") {
                                    for(let x = 0; x < value.values.length; x++) {
                                        let ele = value.values[x];
                                        let valueRoot = ele.values[0].value[0];
                                        if(!valueRoot.value.errorClass && !valueRoot.value.errorCode) {
                                            sendBuffer.push({"value": ele.objectId, "type": 12});
                                        }
                                    }
                                }
                            }

                            if(index == requestBuffer.length - 1) {
                                resolve(sendBuffer);
                            }

                        }).catch(function(error) {
                            reject(error);
                        });
                    } catch(e) {
                        reject(e)
                    }
                }
            }
            
        });
    }

    _readObjectWithRequestArray(deviceAddress, requestArray) {
        let that = this;
        return new Promise((resolve, reject) => {
            this.client.readPropertyMultiple(deviceAddress, requestArray, that.readPropertyMultipleOptions, (error, value) => {
                resolve({
                    error: error,
                    value: value
                });
            });
        });
    }

    _readDeviceName(deviceAddress, deviceId, callback){
        let that = this;
        that.client.readProperty(
            deviceAddress, 
            {type: baEnum.ObjectType.DEVICE, instance: deviceId }, 
            baEnum.PropertyIdentifier.OBJECT_NAME, 
            that.readPropertyMultipleOptions, 
            callback
        );        
    }

    _readObjectList(deviceAddress, deviceId, callback) {
        let that = this;

        try {
            that.client.readProperty(
                deviceAddress, 
                {type: baEnum.ObjectType.DEVICE, instance: deviceId }, 
                baEnum.PropertyIdentifier.OBJECT_LIST,
                that.readPropertyMultipleOptions, 
                callback
            );

        } catch(e) {
            that.logOut("Error reading object list:  ", e);
        }
    }

    _readObject(deviceAddress, type, instance, properties) {
        let that = this;
        return new Promise((resolve, reject) => {
            const requestArray = [{
                objectId: { type: type, instance: instance },
                properties: properties
            }];
            this.client.readPropertyMultiple(deviceAddress, requestArray, that.readPropertyMultipleOptions, (error, value) => {
                resolve({
                    error: error,
                    value: value
                });
            });
        });
    }

    _readObjectFull(deviceAddress, type, instance) {
        let that = this;

        const allProperties = [
            { id: baEnum.PropertyIdentifier.PRESENT_VALUE },
            { id: baEnum.PropertyIdentifier.DESCRIPTION },
            { id: baEnum.PropertyIdentifier.UNITS },
            { id: baEnum.PropertyIdentifier.OBJECT_NAME },
            { id: baEnum.PropertyIdentifier.OBJECT_TYPE },
            { id: baEnum.PropertyIdentifier.OBJECT_IDENTIFIER },
            { id: baEnum.PropertyIdentifier.SYSTEM_STATUS },
            { id: baEnum.PropertyIdentifier.MODIFICATION_DATE },
            { id: baEnum.PropertyIdentifier.PROGRAM_STATE },
            { id: baEnum.PropertyIdentifier.RECORD_COUNT }
        ];

        return new Promise((resolve, reject) => {
            that._readObject(deviceAddress, type, instance, [{ id: baEnum.PropertyIdentifier.ALL }]).then(function(result) {
                
                if(result.value) {
                    resolve(result);
                }

                if(result.error) {
                    const requestArray = [{
                        objectId: { type: type, instance: instance },
                        properties: allProperties
                    }];

                    that._readObjectWithRequestArray(deviceAddress, requestArray).then(function(manualRequest) {
                        if(manualRequest.value) {
                            resolve(manualRequest);
                        }
                        if(manualRequest.error) {
                            reject(manualRequest.error);
                        }
                    })
                }
                
            }).catch(function(error) {
                reject(error);
            });
        });

    };

    _readObjectPropList(deviceAddress, type, instance) {

        return this._readObject(deviceAddress, type, instance, [
            { id: baEnum.PropertyIdentifier.PROPERTY_LIST }
        ]);
    };

    _readObjectId(deviceAddress, type, instance) {

        return this._readObject(deviceAddress, type, instance, [
            { id: baEnum.PropertyIdentifier.OBJECT_IDENTIFIER }
        ]);
    }

    _readObjectPresentValue(deviceAddress, type, instance) {

        return this._readObject(deviceAddress, type, instance, [
            { id: baEnum.PropertyIdentifier.PRESENT_VALUE },
            { id: baEnum.PropertyIdentifier.OBJECT_NAME}
        ]);
    }

    doWrite(value, options){
        let that = this;
        let valuesArray = [];

        options.pointsToWrite.forEach(function(point){

            let deviceAddress = point.deviceAddress;
            
            if(valuesArray[deviceAddress] == null || valuesArray[deviceAddress] == undefined){
                valuesArray[deviceAddress] = [];
            }

            let writeObject = {
                objectId: {
                    type: point.meta.objectId.type,
                    instance: point.meta.objectId.instance
                },
                values: [{
                    property: {
                        id: 85,
                        index: point.meta.arrayIndex
                    },
                    value: [{
                        type: options.appTag,
                        value: value
                    }],
                    priority: options.priority
                }]
            };

            valuesArray[deviceAddress].push(writeObject);
        });

        return that._writePropertyMultiple(valuesArray);
    }

    _writePropertyMultiple(values) {
        let that = this;
        let writePromises = [];
        try {
            return new Promise((resolve, reject) => {
                for(const device in values) {
                    writePromises.push(that.client.writePropertyMultiple(device, values[device], that.readPropertyMultipleOptions, (err, value) => {
                        resolve({
                            error: err,
                            value: value
                        })}
                    ));
                }
    
                Promise.all(writePromises).then(function(result) {
                    resolve(result);
                }).catch(function(e) {
                    that.logOut("Error writing:  ", e);
                });
            });
        } catch (error) {
            that.logOut(error);
        }
    }

    _findValueById(properties, id) {
        const property = properties.find(function (element) {
            return element.id === id;
        });
        if (property && property.value && property.value.length > 0) {
            return property.value[0].value;
        } else {
            return null;
        }
    };

    scanDevice(device) {
        let that = this;
        return new Promise((resolve, reject) => {
            this._readObjectList(device.getAddress(), device.getDeviceId(), (err, result) => {
                if (!err) {
                    try {
                        resolve(result.values);
                    } catch(e) {
                        that.logOut("Issue with getting device point list, see error:  ", e);
                    }
                } else {
                    that.logOut(`Error while fetching objects: ${err}`);
                    reject(err);
                }
            });
        });
    }

    //closes bacnet client
    shutDownClient() {
        let that = this;
        if(that.client) that.client.close((err, result) => {
            that.logOut(err, result);
        });
    };

    globalWhoIs() {
        let that = this;
        if(that.client) {
            that.client.whoIs({'net': 65535});
        } else {
            that.reinitializeClient(that.config);
        }
        that.lastWhoIs = Date.now();
    }


    getNetworkTreeData() {
        let that = this;
        return new Promise(async function(resolve, reject) {
            try {
                const reducedDeviceList = JSON.parse(JSON.stringify(that.deviceList));
                reducedDeviceList.forEach((device) => {
                    delete device["pointsList"];
                });
                resolve({renderList: that.renderList, deviceList: reducedDeviceList, pointList: that.networkTree, pollFrequency: that.discover_polling_schedule});
            } catch(e){
                reject(e);
            }
        });
    }

    getDeviceList() {
        let that = this;
        return new Promise(async function(resolve, reject) {
            try {
                resolve({"deviceList": that.deviceList});
            } catch(e){
                reject(e);
            }
        });
    }

    updateDeviceList(json) {
        let that = this;
        return new Promise(async function(resolve, reject) {
            try {
                let deviceL = json.body.deviceList;
                deviceL.forEach(function(device) {
                    let foundIndex = that.deviceList.findIndex(ele => ele.getDeviceId() == device.deviceId);
                    if(foundIndex == -1) {
                        let newBacnetDevice = new BacnetDevice(false, device);
                        newBacnetDevice.setLastSeen(Date.now());
                        that.deviceList.push(newBacnetDevice);
    
                    } else if(foundIndex !== -1) {
                        that.deviceList[foundIndex].updateDeviceConfig(device);
                        that.deviceList[foundIndex].setLastSeen(Date.now());
                    }
                });

                resolve(true);
            } catch(e) {
                reject(e);
            }
        });
    }

    updatePriorityQueue(priorityDevices) {
        let that = this;
        return new Promise(async function(resolve, reject) {
            try {
                let keys = Object.keys(priorityDevices);
                if(keys.length > 0) { 
                    keys.forEach(function(key) {
                        let device = that.deviceList.find(ele => `${that.getDeviceAddress(ele)}-${ele.getDeviceId()}` == key);
                        let points = priorityDevices[key];
                        if(device) {
                            device.setPriorityQueue(points);
                        }
                    });
                } else if(keys.length == 0) {
                    that.clearPriorityQueues();
                }
                resolve(true);
            } catch(e){
                reject(e);
            }
        });
    }

    clearPriorityQueues() {
        let that = this;
        that.deviceList.forEach(function(device) {
            device.clearPriorityQueue();
        });
    }

    getPriorityDevices() {
        let that = this;
        let priorityDevices = that.deviceList.filter(device => device.getPriorityQueueIsActive() == true);
        return priorityDevices;
    }

    sortDevices(a, b) {
        if (a.deviceId < b.deviceId) {
            return -1;
        } else if (a.deviceId > b.deviceId) {
            return 1;
        }
        return 0; // deviceIds are equal
    }

    sortPoints(a, b) {
        if(a.bacnetType > b.bacnetType) {
            return 1;
        } else if(a.bacnetType < b.bacnetType) {
            return -1;
        } else if(a.bacnetType == b.bacnetType) {
            return 0;
        }

        return a.label.localeCompare(b.label)
    }

    buildNetworkTreeData() {
        let that = this;  
        that.buildTreeMutex = new Mutex();
        let displayNameCharThreshold = 40;

        Store_Config(JSON.stringify({renderList: that.renderList, deviceList: that.deviceList, pointList: that.networkTree}));

        return new Promise(async function(resolve, reject) {
            if(!that.renderList) that.renderList = [];
            if(that.deviceList && that.networkTree) {
                that.deviceList.forEach(function(deviceInfo, index) {
                    that.buildTreeMutex 
                    .acquire()
                    .then(function(release) {

                        let ipAddr = typeof deviceInfo.getAddress() == "object" ? deviceInfo.getAddress().address : deviceInfo.getAddress();
                        let deviceId = deviceInfo.getDeviceId();
                        let deviceName = deviceInfo.getDeviceName() == null ? ipAddr : deviceInfo.getDeviceName();
                        let deviceKey = ipAddr + "-" + deviceInfo.getDeviceId();
                        let deviceObject = that.networkTree[deviceKey];
                        let isMstpDevice = deviceInfo.getIsMstpDevice();
                        let manualDiscoveryMode = deviceInfo.getManualDiscoveryMode();

                        if(deviceObject && typeof deviceName !== "object") {
                            let children = [];
                            let pointIndex = 0;

                            for(const pointName in deviceObject) {
                                let pointProperties = [];
                                let values = deviceObject[pointName];
                                let displayName = pointName;
                                if(pointName.length > displayNameCharThreshold) {
                                    displayName = "";
                                    let charArray = pointName.split("");
                                    for(let i = 0; i < charArray.length; i++) {
                                        if(i < displayNameCharThreshold){
                                            displayName += charArray[i];
                                        }
                                    }
                                    displayName += "...";
                                }

                                if(values.objectName){
                                    pointProperties.push({"key": `${index}-${pointIndex}-0`, "label": `Name: ${values.objectName}`, "data": values.objectName, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.objectType){
                                    pointProperties.push({"key": `${index}-${pointIndex}-1`, "label": `Object Type: ${values.objectType}`, "data": values.objectType, "icon": "pi pi-bolt", "children": null});
                                } 
                                if(values.objectID && values.objectID.instance) {
                                    pointProperties.push({"key": `${index}-${pointIndex}-2`, "label": `Object Instance: ${values.objectID.instance}`, "data": values.objectID.instance, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.description){
                                    pointProperties.push({"key": `${index}-${pointIndex}-3`, "label": `Description: ${values.description}`, "data": `${values.description}`, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.units){
                                    pointProperties.push({"key": `${index}-${pointIndex}-4`, "label": `Units: ${values.units}`, "data": `${values.units}`, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.presentValue !== "undefined" && values.presentValue !== null && typeof values.presentValue !== "undefined") {
                                    pointProperties.push({"key": `${index}-${pointIndex}-5`, "label": `Present Value: ${values.presentValue}`, "data": `${values.presentValue}`, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.systemStatus !== null && typeof values.systemStatus !== "undefined" && values.systemStatus !== ""){
                                    pointProperties.push({"key": `${index}-${pointIndex}-6`, "label": `System Status: ${values.systemStatus}`, "data": `${values.systemStatus}`, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.modificationDate && !values.modificationDate.errorClass) {
                                    pointProperties.push({"key": `${index}-${pointIndex}-7`, "label": `Modification Date: ${values.modificationDate}`, "data": `${values.modificationDate}`, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.programState){
                                    pointProperties.push({"key": `${index}-${pointIndex}-8`, "label": `Program State: ${values.programState}`, "data": `${values.programState}`, "icon": "pi pi-bolt", "children": null});
                                }
                                if(values.recordCount && !values.recordCount.errorClass){
                                    pointProperties.push({"key": `${index}-${pointIndex}-9`, "label": `Record Count: ${values.recordCount}`, "data": `${values.recordCount}`, "icon": "pi pi-bolt", "children": null});
                                }

                                children.push({"key": `${index}-${pointIndex}`, "label": displayName, "data": displayName, "pointName": pointName, "icon": that.getPointIcon(values.meta.objectId.type), "children": pointProperties, "type": "point", "parentDevice": deviceName, "showAdded": false, "bacnetType": values.meta.objectId.type})
                                pointIndex++;
                            }
                            let foundIndex = that.renderList.findIndex(ele => ele.deviceId == deviceId && ele.ipAddr == ipAddr);
                            if(foundIndex !== -1) {
                                that.renderList[foundIndex] = {"key": index, "label": deviceName, "data": deviceName, "icon": that.getDeviceIcon(isMstpDevice, manualDiscoveryMode), "children": children.sort(that.sortPoints), "type": "device", "lastSeen": deviceInfo.getLastSeen(), "showAdded": false, "ipAddr": ipAddr, "deviceId": deviceId, "isMstpDevice": isMstpDevice};
                            } else if(foundIndex == -1) {
                                that.renderList.push({"key": index, "label": deviceName, "data": deviceName, "icon": that.getDeviceIcon(isMstpDevice, manualDiscoveryMode), "children": children.sort(that.sortPoints), "type": "device", "lastSeen": deviceInfo.getLastSeen(), "showAdded": false, "ipAddr": ipAddr, "deviceId": deviceId, "isMstpDevice": isMstpDevice});
                            }
                            if(index == that.deviceList.length - 1) {
                                that.renderList.sort(that.sortDevices);
                                resolve({renderList: that.renderList, deviceList: that.deviceList, pointList: that.networkTree, pollFrequency: that.discover_polling_schedule});
                            }
                        } else {
                            if(index == that.deviceList.length - 1) {
                                that.renderList.sort(that.sortDevices);
                                resolve({renderList: that.renderList, deviceList: that.deviceList, pointList: that.networkTree, pollFrequency: that.discover_polling_schedule});
                            }
                        }

                        release();
                    });
                    
                });
            }
        });
    }

    buildJsonObject(device, priorityQueue) {
        let that = this;
        let address = device.address;
        let pointList = priorityQueue !== null ? priorityQueue : device.getPointsList();
        let requestMutex = new Mutex();

        return new Promise(function(resolve, reject) {
            let promiseArray = [];
            if(typeof pointList !== "undefined" && pointList.length > 0) {
                pointList.forEach(function(point, pointListIndex) {
                    requestMutex
                    .acquire()
                    .then(function(release) {
                        that._readObjectFull(address, point.value.type, point.value.instance).then(function(result) {

                            if(!result.error) {
                                promiseArray.push(result);
                            }

                            release();

                            if(pointListIndex == pointList.length - 1) {
                                that.buildResponse(promiseArray, device).then(function() {
                                    that.lastNetworkPoll = Date.now();
                                    resolve({deviceList: that.deviceList, pointList: that.networkTree});
                                }).catch(function(e){
                                    that.logOut("Error while building json object: ", e);
                                    reject(e);
                                });
                            }
                            
                        }).catch(function(e) {
                            release();
                            that.logOut("_readObjectFull error: ", e);

                            if(pointListIndex == pointList.length - 1) {
                                that.buildResponse(promiseArray, device).then(function() {
                                    that.lastNetworkPoll = Date.now();
                                    resolve({deviceList: that.deviceList, pointList: that.networkTree});
                                }).catch(function(e){
                                    that.logOut("Error while building json object: ", e);
                                    reject(e);
                                });
                            }
                        });
                    });
                });
            } else {
                reject("Unable to build network tree, empty point list");
            }
        });
    }

    // Builds response object for a fully qualified 
    buildResponse(fullObjects, device) {
        let that = this;

        return new Promise(function(resolve, reject) {
            let deviceKey = (typeof device.getAddress() == "object") ? device.getAddress().address + "-" + device.getDeviceId() : device.getAddress() + "-" + device.getDeviceId();            
            let values = that.networkTree[deviceKey] ? that.networkTree[deviceKey] : {};
            for(let i = 0; i < fullObjects.length; i++) {            
                let obj = fullObjects[i];
                let successfulResult = !obj.error ? obj.value : null;
                if(successfulResult) {
                    successfulResult.values.forEach(function(pointProperty, pointPropertyIndex) {
                        let currobjectId = pointProperty.objectId.type
                        let bac_obj = that.getObjectType(currobjectId);
                        let objectName = that._findValueById(pointProperty.values, baEnum.PropertyIdentifier.OBJECT_NAME);
                        let objectType = that._findValueById(pointProperty.values, baEnum.PropertyIdentifier.OBJECT_TYPE);
                        let objectId;
                        if(objectName !== null && typeof objectName == "string") {
                            objectId = objectName + "_" + bac_obj + '_' + pointProperty.objectId.instance;
                        
                            try {
                                pointProperty.values.forEach(function(object, objectIndex) {
                                    //checks for error code json structure, returned for invalid bacnet requests
                                    if(object && object.value && !object.value.errorClass) {

                                        if(!values[objectId]) values[objectId] = {};
                                        values[objectId].meta = {
                                            objectId: pointProperty.objectId
                                        };

                                        switch(object.id) {
                                            case baEnum.PropertyIdentifier.PRESENT_VALUE:
                                                if(object.value[0] && object.value[0].value !== "undefined" && object.value[0].value !== null) {
                                                    //check for binary object type
                                                    if(objectType == 3 || objectType == 4 || objectType == 5) {
                                                        if(object.value[0].value == 0) {
                                                            values[objectId].presentValue = false;
                                                        } else if(object.value[0].value == 1) {
                                                            values[objectId].presentValue = true;
                                                        }
                                                    } else if(objectType == 40) {
                                                            //character string
                                                            values[objectId].presentValue = object.value[0].value;
                                                    } else {
                                                        values[objectId].presentValue = roundDecimalPlaces(object.value[0].value, 2);
                                                    }
                                                } 
                                                values[objectId].meta.arrayIndex = object.index;
                                                break;
                                            case baEnum.PropertyIdentifier.DESCRIPTION:
                                                if(object.value[0]) values[objectId].description = object.value[0].value;
                                                break;
                                            case baEnum.PropertyIdentifier.UNITS:
                                                if(object.value[0] && object.value[0].value) values[objectId].units = getUnit(object.value[0].value);
                                                break;
                                            case baEnum.PropertyIdentifier.OBJECT_NAME:
                                                if(object.value[0] && object.value[0].value) values[objectId].objectName = object.value[0].value;
                                                break;
                                            case baEnum.PropertyIdentifier.OBJECT_TYPE:
                                                if(object.value[0] && object.value[0].value) values[objectId].objectType = object.value[0].value;
                                                break;
                                            case baEnum.PropertyIdentifier.OBJECT_IDENTIFIER:
                                                if(object.value[0] && object.value[0].value) values[objectId].objectID = object.value[0].value;
                                                break;    
                                            case baEnum.PropertyIdentifier.PROPERTY_LIST:
                                                if(object.value) values[objectId].propertyList = that.mapPropsToArray(object.value);
                                                break;         
                                                
                                            case baEnum.PropertyIdentifier.SYSTEM_STATUS:
                                                if(object.value[0]){
                                                    values[objectId].systemStatus = that.getPROP_SYSTEM_STATUS(object.value[0].value);
                                                } 
                                                break;    

                                            case baEnum.PropertyIdentifier.MODIFICATION_DATE:
                                                if(object.value[0]) {
                                                    values[objectId].modificationDate = object.value[0].value;
                                                }
                                                break;      
                                            
                                            case baEnum.PropertyIdentifier.PROGRAM_STATE:
                                                if(object.value[0]){
                                                    values[objectId].programState = that.getPROP_PROGRAM_STATE(object.value[0].value);
                                                }
                                                break;

                                            case baEnum.PropertyIdentifier.RECORD_COUNT:
                                                if(object.value[0] ) {
                                                    values[objectId].recordCount = object.value[0].value;
                                                }
                                                break;                                            
                                        }
                                    }
                                    if(pointPropertyIndex == successfulResult.values.length - 1 && objectIndex == pointProperty.values.length - 1 && i == fullObjects.length - 1) {
                                        that.networkTree[deviceKey] = values;
                                        resolve(that.networkTree);
                                    } 
                                });
                            } catch(e) {
                                that.logOut("issue resolving bacnet payload, see error:  ", e);
                                reject(e);
                            }
                        }
                    });
                } else {
                    //error found in point property
                    if(i == fullObjects.length - 1) {
                        that.networkTree[deviceKey] = values;
                        resolve(that.networkTree);
                    }
                }
            }
            that.networkTree[deviceKey] = values;
            resolve(that.networkTree);
        });
    }

    mapPropsToArray(propertyList) {
        let uniquePropArray = [];
        for(let i = 0; i < propertyList.length; i++) {
            if(uniquePropArray.indexOf(propertyList[i].value) === -1) uniquePropArray.push(propertyList[i].value);
        }
        return uniquePropArray;
    }

    getPROP_PROGRAM_STATE(value) {
        switch(value) {
            case 0:
                return "0 - Idle";
            case 1:
                return "1 - Loading";
            case 2:
                return "2 - Running";
            case 3:
                return "3 - Waiting";
            case 4:
                return "4 - Halted";
            case 5:
                return "5 - Unloading";
            default:
                return "";
        }
    }

    getPROP_SYSTEM_STATUS(value) {
        switch(value) {
            case 0:
                return "0 - Operational";
            case 1:
                return "1 - Operational Readonly";
            case 2:
                return "2 - Download Required";
            case 3:
                return "3 - Download In Progress";
            case 4:
                return "4 - Non Operational";
            case 5:
                return "5 - Backup In Progress";
            default:
                return "";
        }
    }

    getPointIcon(objectId) {
        switch(objectId) {
            case 0:
                //AI
                return "pi pi-tags";
            case 1:
                //AO
                return "pi pi-tags";
            case 2:
                //AV
                return "pi pi-tags";
            case 3: 
                //BI
                return "pi pi-tags";
            case 4:
                //BO
                return "pi pi-tags";
            case 5:
                //BV
                return "pi pi-tags";
            case 8:
                //Device
                return "pi pi-box";
            case 13: 
                //MI
                return "pi pi-tags";
            case 14:
                //MO
                return "pi pi-tags";
            case 19:
                //MV
                return "pi pi-tags";
            case 10:
                //File
                return "pi pi-file";
            case 16:
                //Program
                return "pi pi-database";
            case 20:
                //Trendlog
                return "pi pi-chart-line";
            case 15:
                //Notification Class
                return "pi pi-bell";
            case 56:
                return "pi pi-sitemap";
            case 178:
                return "pi pi-lock";    
            case 17:
                return "pi pi-calendar";
            case 6:
                return "pi pi-calendar";
            default:
                //Return circle for all other types
                return "pi pi-tags";
        }
    }

    getObjectType(objectId) {
        switch(objectId) {
            case 0:
                return "AI";
            case 1:
                return "AO";
            case 2:
                return "AV";
            case 3: 
                return "BI";
            case 4:
                return "BO";
            case 5:
                return "BV";
            case 8:
                return "Device";
            case 13: 
                return "MI";
            case 14:
                return "MO";
            case 19:
                return "MV";
            case 40:
                return "CS";
            default: 
                return "";
        }
    }

    getPROP_RELIABILITY(value) {
        switch(value) {
            case 0:
                return "No Fault Detected";
            case 1:
                return "No Sensor";
            case 2:
                return "Over Range";
            case 3: 
                return "Under Range";
            case 4:
                return "Open Loop";
            case 5:
                return "Shorted Loop";
            case 6:
                return "No Output";
            case 7:
                return "Unreliable Other";
            case 8:
                return "Process Error";
            case 9:
                return "Multi State Fault";    
            case 10:
                return "Configuration Error";
            case 11:
                return "Member Fault";
            case 12:
                return "Communication Failure";
            case 13:
                return "Tripped";
            default:
                return "";            
        }
    }

    getStatusFlags(flags) {
        return flags.value[0].value;
    }

    getDeviceIcon(isMstp, manualDiscoveryMode) {
        if(manualDiscoveryMode == true) {
            //return "pi pi-server"
            return "pi pi-exclamation-triangle"
        } else if(manualDiscoveryMode == false) {
            if(isMstp == true) {
                return "pi pi-share-alt"
            } else if(isMstp == false) {
               return "pi pi-server"
            }
        }

        return "pi pi-server";
    };
}

module.exports = { BacnetClient };
