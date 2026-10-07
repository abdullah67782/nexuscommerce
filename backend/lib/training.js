// Model training (fine-tuning) is disabled unless explicitly enabled in the
// server configuration. Read on every request so it cannot be bypassed by
// the client and can be changed without code edits.
const isManualTrainingEnabled = () => process.env.MANUAL_FINETUNE_ENABLED === 'true';

const TRAINING_DISABLED = {
  error: 'training_disabled',
  message: 'Training new personal models is turned off: in testing, extra store-specific training did not '
    + 'reliably improve forecasts. Forecasts keep using the general model, or a personal model trained earlier. '
    + 'Existing models and their history are kept.',
};

module.exports = { isManualTrainingEnabled, TRAINING_DISABLED };
