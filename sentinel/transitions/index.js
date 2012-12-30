var _ = require('underscore'),
    async = require('async'),
    fs = require('fs'),
    path = require('path'),
    db = require('../db'),
    transitions = {},
    queue;

// read all files in this directory and use every one except index.js as a transition
_.each(fs.readdirSync(__dirname), function(file) {
    var transition,
        key = path.basename(file, path.extname(file));

    try {
        if (file !== 'index.js') {
            transition = require('./' + key);
            transitions[key] = transition;
        }
    } catch(e) {
        // only log exceptions
        console.error(e);
    }
});

// create a queue to handle the changes, calling the onMatch of the transitions one by one
queue = async.queue(function(job, callback) {
    var transition = job.transition,
        key = job.key,
        change = job.change;
    transition.onMatch(change, function(err, complete) {
        if (err || complete) {
            finalize({
                key: key,
                change: change,
                err: err
            }, callback);
        } else {
            callback();
        }
    });
}, 1);

module.exports = {
    attachTransition: function(transition, key) {
        var stream;


        db.view('kujua-sentinel', 'last_valid_seq', {
            key: key
        }, function(err, data) {
            var row = _.first(data.rows),
                since = row && row.value && row.value.seq || 0;

            // get a stream of changes from the database
            stream = db.changesStream({
                since: since,
                filter: 'kujua-sentinel/' + key
            });
            stream.on('data', function(change) {
                // ignore documents that have been deleted; there's nothing to update
                if (!change.deleted) {
                    // get the latest document
                    db.getDoc(change.id, function(err, doc) {
                        var transitions = doc.transitions || {};

                        if (!err && doc) {
                            if (transition.repeatable || !transitions[key] || !transitions[key].ok) {
                                change.doc = doc;
                                queue.push({
                                    change: change,
                                    key: key,
                                    transition: transition
                                });
                            }
                        }
                    });
                }
            });
            console.log('Listening for changes for the ' + key + ' transition from sequence number ' + since);
        });
    },
    // Attach a transition to a stream of changes from the database.
    attach: function(design) {
        _.each(transitions, function(transition, key) {

            // don't attach if it doesn't have a filter
            if (!design.filters || !design.filters[key]) {
                console.warn("MISSING " + key + " filter, skipping transition!");
                return;
            }

            module.exports.attachTransition(transition, key);

        });
    }
}

// mark the transition as completed
function finalize(options, callback) {
    var change = options.change,
        key = options.key,
        err = options.err,
        doc = change.doc;

    doc.transitions = doc.transitions || {};
    if (err) {
        doc.transitions[key] = {
            ok: false,
            seq: change.seq - 1
        };
    } else {
        doc.transitions[key] = {
            ok: true,
            seq: change.seq
        };
    }

    db.getDoc(doc._id, function(err, existing) {
        if (err) {
            console.log(JSON.stringify(err));
            callback(err);
        } else {
            if (JSON.stringify(_.omit(existing, '_rev')) !== JSON.stringify(_.omit(doc, '_rev'))) {
                db.saveDoc(doc, function(err, result) {
                    if (err) {
                        console.log(JSON.stringify(err));
                    }
                    callback(err);
                });
            } else {
                callback();
            }
        }
    });
}