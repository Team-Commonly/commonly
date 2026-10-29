/**
 * The computer setup command, read from its one source: the frontend helper
 * that builds it for the page's instance (TASK-547). Backend copy that repeats
 * the command (Scout's prompt, the docs site) is checked against this template
 * with the API URL left as a placeholder, so each copy keeps its own instance.
 */
const fs = require('fs');
const path = require('path');

const HELPER = path.resolve(__dirname, '../../../frontend/src/v2/utils/daemonSetupCommand.ts');

const daemonSetupCommandTemplate = (apiUrl) => {
  const template = fs.readFileSync(HELPER, 'utf8').match(/`(npm i -g [^`]+)`/)[1];
  return template.replace(/\$\{apiUrl[^}]*\}/, apiUrl);
};

module.exports = { daemonSetupCommandTemplate };
