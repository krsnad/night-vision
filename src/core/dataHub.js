
// Data container (original plus subset data)
// + Completes the structure to a full state
// + Implements various update operations.

import Utils from '../stuff/utils.js'
import Events from './events.js'
import SeClient from './se/seClient.js'
import DataView$ from './dataView.js'

class DataHub {

    constructor(nvId) {

        let events = Events.instance(nvId)
        let se = SeClient.instance(nvId)
        this.events = events
        this.se = se
        se.hub = this // Set a ref to the hub
        

        // EVENT INTERFACE
        events.on('hub:set-scale-index', this.onScaleIndex.bind(this))
        events.on('hub:display-overlay', this.onDisplayOv.bind(this))
    }

    init(data) {

        // [API] All here are read-only

        // Data object
        this.data = data
        // Index based mode
        this.indexBased = data.indexBased ?? false

        this.chart = null // Pane with the main overlay (main pane)
        this.offchart = null // All other panes
        this.mainOv = null // Main overlay ref
        this.mainPaneId = null // Mane pane id
        this.tsIndexMap = null // Time-index map

        this.createTsIndexMap()

    }

    // create a timeseries index mapping on the main overlay
    createTsIndexMap() {
        let all = Utils.allOverlays(this.data.panes)
        let mainOv = all.find(x => x.main) || all[0]
        if  (!mainOv) return

        let data = mainOv.data
        let tsIndexMap = new Map()
        for (var i = 0; i < data.length; i++) {
            tsIndexMap.set(data[i][0], i)
        }
        this.tsIndexMap = tsIndexMap
    }


    // Common function to update overlay data
    updateOverlayData(overlay, range, mainOverlayRange) {
        let off = overlay.indexOffset || 0;
        
        if (this.mainOv !== overlay && ['Sparse'].includes(overlay.type)) {
            overlay.dataView = this.filter(overlay.data, mainOverlayRange, off, true);
        } else {
            overlay.dataView = this.filter(overlay.data, range, off);
        }
        
        overlay.dataSubset = overlay.dataView.makeSubset();
    }

    // Update data on 'range-changed'. Applies filters only.
    updateRange(range) {
        let mainOverlayRange = [undefined, undefined];

        for (let pane of this.data.panes || []) {
            for (let overlay of pane.overlays || []) {
                this.updateOverlayData(overlay, range, mainOverlayRange);
                
                // Update mainOverlayRange if this is the main overlay
                if (overlay.data && (overlay === this.mainOv || !this.mainOv)) {
                    mainOverlayRange = [
                        overlay.data[overlay.dataView.i1][0],
                        overlay.data[overlay.dataView.i2][0]
                    ];
                }
            }
        }
    }



    // Calculate visible data section
    // (& completes the main structure)
    // TODO: smarter algo of adding/removing panes. Uuids
    // should remain the same if pane still exists
    calcSubset(range) {
        let paneId = 0;
        for (let pane of this.data.panes || []) {
            this.setupPane(pane, paneId++, range);
        }
    }

    // Setup individual pane and its overlays
    setupPane(pane, paneId, range) {
        pane.id = paneId;
        pane.overlays = pane.overlays || [];
        pane.settings = pane.settings || {};
        pane.uuid = pane.uuid || Utils.uuid3();

        let mainOverlayRange = [undefined, undefined];
        let ovId = 0;
        for (let overlay of pane.overlays) {
            this.setupOverlay(overlay, ovId++, range, mainOverlayRange);
            
            // Update mainOverlayRange if this is the main overlay
            if (overlay.data && (overlay === this.mainOv || !this.mainOv)) {
                console.log('mainOverlayRange', overlay.data[overlay.dataView.i1])
                mainOverlayRange = [
                    overlay.data[overlay.dataView.i1][0],
                    overlay.data[overlay.dataView.i2][0]
                ];
            }
        }
    }

    // Setup individual overlay
    setupOverlay(overlay, ovId, range, mainOverlayRange) {
        overlay.id = ovId;
        overlay.main = !!overlay.main;
        overlay.data = overlay.data || [];
        overlay.dataExt = overlay.dataExt || {};
        overlay.settings = overlay.settings || {};
        overlay.props = overlay.props || {};
        overlay.uuid = overlay.uuid || Utils.uuid3();

        this.updateOverlayData(overlay, range, mainOverlayRange);
    }

    // Load indicator scripts
    async loadScripts(exec = false) {
        for (var pane of this.data.panes || []) {
            var scriptId = 0
            pane.scripts = pane.scripts || []
            for (var s of pane.scripts) {
                s.id = scriptId++
                s.settings = s.settings || {}
                s.props = s.props || {}
                s.uuid = s.uuid || Utils.uuid3()
            }
        }
        if (exec) {
            await Utils.pause(0) // Wait for init
            await this.se.uploadAndExec()
        }
    }

    // Detect the main chart, define offcharts
    detectMain() {

        // TODO: remove duplicate code here & in dataScanner
        let all = Utils.allOverlays(this.data.panes)
        let mainOv = all.find(x => x.main) || all[0]

        if (!all.length || !mainOv) return

        mainOv.main = true // If there is only one OV

        this.chart = this.data.panes.find(
            x => x.overlays.find(
                y => y.main
            )
        )

        this.offchart = this.data.panes.filter(
            x => x !== this.chart
        )

        this.mainOv = mainOv
        this.mainPaneId = this.panes().indexOf(this.chart)

        // Remove all 'main' overlays except the first
        for (var ov of all) {
            if (ov !== mainOv) ov.main = false
        }

    }

    // [API] Create a subset of timeseries
    filter (data, range, offset = 0, force_value_based = false) {

        let filter;
        if (force_value_based) {
            filter = Utils.findTimeRange;
        } else {
            filter = this.indexBased ? Utils.fastFilterIB : Utils.findTimeRange;
        }
        // console.log('filter')
        // console.log('data len', data.length)
        // console.log('filter args', range[0]-offset, range[1]-offset)
        var ix = filter(
            data,
            range[0] - offset,
            range[1] - offset
        )
        // console.log(ix[0], ix[1])

        return new DataView$(data, ix[0], ix[1])
    }

    // [API] Get all active panes (with uuid)
    panes() {
        return (this.data.panes || []).filter(x =>
            x.uuid)
    }

    // [API] Get overlay ref by paneId & ovId
    overlay(paneId, ovId) {
        return this.panes()[paneId]?.overlays[ovId]
    }

    // [API] Get overlay data by paneId & ovId
    ovData(paneId, ovId) {
        return this.panes()[paneId]
            ?.overlays[ovId]?.data
    }

    // [API] Get overlay extra data by paneId & ovId
    ovDataExt(paneId, ovId) {
        return this.panes()[paneId]
            ?.overlays[ovId]?.dataExt
    }

    // [API] Get overlay data subset by paneId & ovId
    ovDataSubset(paneId, ovId) {
        return this.panes()[paneId]
            ?.overlays[ovId]?.dataSubset
    }

    // [API] Get All overlays
    allOverlays(type) {
        let all = Utils.allOverlays(this.data.panes)
        return type ? all.filter(x => x.type === type) : all
    }

    // Event handlers

    onScaleIndex(event) {

        let pane = this.panes()[event.paneId]
        if (!pane) return

        // Main scale index (that used for the grid)
        pane.settings.scaleIndex = event.index

        // Local left & right indices used to
        // display the correct Scale
        pane.settings.scaleSideIdxs = event.sideIdxs

        this.events.emitSpec('chart', 'update-layout')
    }

    onDisplayOv(event) {

        let pane = this.panes()[event.paneId]
        if (!pane) return

        let ov = pane.overlays[event.ovId]
        if (!ov) return

        ov.settings.display = event.flag

        // Legend-line id
        let llId = `${event.paneId}-${event.ovId}`

        this.events.emitSpec('chart', 'update-layout')
        this.events.emitSpec(`ll-${llId}`, 'update-ll')

    }

}

let instances = {}

function instance(id) {
    if (!instances[id]) {
        instances[id] = new DataHub(id)
    }
    return instances[id]
}

export default { instance }
