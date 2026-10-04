'use strict';

// Issue240 class fix: one typed process-owner evidence owner plus consumers that
// settle only on proved absence. These tests exercise the classifier table, the
// legacy-boolean boundary, every destructive consumer, and a structural inventory
// that goes red on a new private PID probe or a legacy-false destructive copy.

require('./process-owner-evidence-scenarios/classifier.cjs');
require('./process-owner-evidence-scenarios/journal-recovery.cjs');
require('./process-owner-evidence-scenarios/town-hall.cjs');
require('./process-owner-evidence-scenarios/staged-files.cjs');
require('./process-owner-evidence-scenarios/admission.cjs');
require('./process-owner-evidence-scenarios/inventory.cjs');
