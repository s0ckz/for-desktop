export const sinkName = "stoat-virtual-sink";
export const sourceName = "stoat-virtual-source";

// Defaults to our self-hosted instance. Note there is no /app path here: the
// self-hosted web client is served at the root, unlike stoat.chat.
// Override at launch with --force-server=https://example.com
export const DEFAULT_SERVER = "https://stoat.lrl.com.br";
