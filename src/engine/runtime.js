var EventEmitter = require('events');
var Sequencer = require('./sequencer');
var Thread = require('./thread');
var util = require('util');

var defaultBlockPackages = {
    'scratch3_control': require('../blocks/scratch3_control'),
    'scratch3_event': require('../blocks/scratch3_event'),
    'scratch3_operators': require('../blocks/scratch3_operators')
};

/**
 * Manages blocks, stacks, and the sequencer.
 * @param {!Blocks} blocks Blocks instance for this runtime.
 */
function Runtime (blocks) {
    // Bind event emitter
    EventEmitter.call(this);

    // State for the runtime

    /**
     * Block management and storage
     */
    this.blocks = blocks;

    /**
     * A list of threads that are currently running in the VM.
     * Threads are added when execution starts and pruned when execution ends.
     * @type {Array.<Thread>}
     */
    this.threads = [];

    /** @type {!Sequencer} */
    this.sequencer = new Sequencer(this);

    /**
     * Map to look up a block primitive's implementation function by its opcode.
     * This is a two-step lookup: package name first, then primitive name.
     * @type {Object.<string, Function>}
     */
    this._primitives = {};
    this._registerBlockPackages();
}

/**
 * Event name for glowing a stack
 * @const {string}
 */
Runtime.STACK_GLOW_ON = 'STACK_GLOW_ON';

/**
 * Event name for unglowing a stack
 * @const {string}
 */
Runtime.STACK_GLOW_OFF = 'STACK_GLOW_OFF';

/**
 * Event name for glowing a block
 * @const {string}
 */
Runtime.BLOCK_GLOW_ON = 'BLOCK_GLOW_ON';

/**
 * Event name for unglowing a block
 * @const {string}
 */
Runtime.BLOCK_GLOW_OFF = 'BLOCK_GLOW_OFF';

/**
 * Inherit from EventEmitter
 */
util.inherits(Runtime, EventEmitter);

/**
 * How rapidly we try to step threads, in ms.
 */
Runtime.THREAD_STEP_INTERVAL = 1000 / 30;


// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------

/**
 * Register default block packages with this runtime.
 * @todo Prefix opcodes with package name.
 * @private
 */
Runtime.prototype._registerBlockPackages = function () {
    for (var packageName in defaultBlockPackages) {
        if (defaultBlockPackages.hasOwnProperty(packageName)) {
            // @todo pass a different runtime depending on package privilege?
            var packageObject = new (defaultBlockPackages[packageName])(this);
            var packageContents = packageObject.getPrimitives();
            for (var op in packageContents) {
                if (packageContents.hasOwnProperty(op)) {
                    this._primitives[op] =
                        packageContents[op].bind(packageObject);
                }
            }
        }
    }
};

/**
 * Retrieve the function associated with the given opcode.
 * @param {!string} opcode The opcode to look up.
 * @return {Function} The function which implements the opcode.
 */
Runtime.prototype.getOpcodeFunction = function (opcode) {
    return this._primitives[opcode];
};

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------

/**
 * Create a thread and push it to the list of threads.
 * @param {!string} id ID of block that starts the stack
 */
Runtime.prototype._pushThread = function (id) {
    this.emit(Runtime.STACK_GLOW_ON, id);
    var thread = new Thread(id);
    thread.pushStack(id);
    this.threads.push(thread);
};

/**
 * Remove a thread from the list of threads.
 * @param {?Thread} thread Thread object to remove from actives
 */
Runtime.prototype._removeThread = function (thread) {
    var i = this.threads.indexOf(thread);
    if (i > -1) {
        this.emit(Runtime.STACK_GLOW_OFF, thread.topBlock);
        this.threads.splice(i, 1);
    }
};

/**
 * Toggle a stack
 * @param {!string} stackId ID of block that starts the stack
 */
Runtime.prototype.toggleStack = function (stackId) {
    // Remove any existing thread
    for (var i = 0; i < this.threads.length; i++) {
        if (this.threads[i].topBlock == stackId) {
            this._removeThread(this.threads[i]);
            return;
        }
    }
    // Otherwise add it
    this._pushThread(stackId);
};

/**
 * Green flag, which stops currently running threads
 * and adds all top-level stacks that start with the green flag
 */
Runtime.prototype.greenFlag = function () {
    // Remove all existing threads
    for (var i = 0; i < this.threads.length; i++) {
        this._removeThread(this.threads[i]);
    }
    // Add all top stacks with green flag
    var stacks = this.blocks.getStacks();
    for (var j = 0; j < stacks.length; j++) {
        var topBlock = stacks[j];
        if (this.blocks.getBlock(topBlock).opcode === 'event_whenflagclicked') {
            this._pushThread(stacks[j]);
        }
    }
};

/**
 * Distance sensor hack
 */
Runtime.prototype.startDistanceSensors = function () {
    // Add all top stacks with distance sensor
    var stacks = this.blocks.getStacks();
    for (var j = 0; j < stacks.length; j++) {
        var topBlock = stacks[j];
        if (this.blocks.getBlock(topBlock).opcode ===
            'wedo_whendistanceclose') {
            var alreadyRunning = false;
            for (var k = 0; k < this.threads.length; k++) {
                if (this.threads[k].topBlock === topBlock) {
                    alreadyRunning = true;
                }
            }
            if (!alreadyRunning) {
                this._pushThread(stacks[j]);
            }
        }
    }
};

/**
 * Stop "everything"
 */
Runtime.prototype.stopAll = function () {
    var threadsCopy = this.threads.slice();
    while (threadsCopy.length > 0) {
        var poppedThread = threadsCopy.pop();
        // Unglow any blocks on this thread's stack.
        for (var i = 0; i < poppedThread.stack.length; i++) {
            this.glowBlock(poppedThread.stack[i], false);
        }
        // Actually remove the thread.
        this._removeThread(poppedThread);
    }
};

/**
 * Repeatedly run `sequencer.stepThreads` and filter out
 * inactive threads after each iteration.
 */
Runtime.prototype._step = function () {
    var inactiveThreads = this.sequencer.stepThreads(this.threads);
    for (var i = 0; i < inactiveThreads.length; i++) {
        this._removeThread(inactiveThreads[i]);
    }
};

/**
 * Emit feedback for block glowing (used in the sequencer).
 * @param {?string} blockId ID for the block to update glow
 * @param {boolean} isGlowing True to turn on glow; false to turn off.
 */
Runtime.prototype.glowBlock = function (blockId, isGlowing) {
    if (!this.blocks.getBlock(blockId)) {
        return;
    }
    if (isGlowing) {
        this.emit(Runtime.BLOCK_GLOW_ON, blockId);
    } else {
        this.emit(Runtime.BLOCK_GLOW_OFF, blockId);
    }
};

/**
 * setInterval implementation that works in a WebWorker or not.
 * @param {?Function} fcn Function to call.
 * @param {number} interval Interval at which to call it.
 * @return {number} Value returned by setInterval.
 */
Runtime.prototype._setInterval = function(fcn, interval) {
    var setInterval = null;
    if (typeof window !== 'undefined' && window.setInterval) {
        setInterval = window.setInterval;
    } else if (typeof self !== 'undefined' && self.setInterval) {
        setInterval = self.setInterval;
    } else {
        return;
    }
    return setInterval(fcn, interval);
};

/**
 * Set up timers to repeatedly step in a browser
 */
Runtime.prototype.start = function () {
    this._setInterval(function() {
        this._step();
    }.bind(this), Runtime.THREAD_STEP_INTERVAL);
};

module.exports = Runtime;
