import { config } from 'dotenv';
import core = require('@actions/core');
import { WebClient } from '@slack/web-api';
import pty = require('node-pty');
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

config();

const REQUIRED_ENV = [
  'SLACK_TOKEN',
  'CONVERSATION_ID',
  'PUBLISH_COMMAND',
  'CODE_PATTERN',
];
REQUIRED_ENV.forEach(key => {
  const missing = [];
  if (!process.env[key]) {
    missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables ${missing.join(', ')}`,
    );
  }
});

const getInputs = () => {
  const {
    SLACK_TOKEN = '',
    CONVERSATION_ID = '',
    PUBLISH_COMMAND = '',
    CODE_PATTERN = '',
    TIMEOUT = `${20 * 60 * 1000}`,
  } = process.env;

  const parts = PUBLISH_COMMAND.split('\n');
  const command = parts[0];
  const args = parts.slice(1);
  console.log(
    `Received publish command of '${command}' with args '${args.join(',')}'`,
  );
  return {
    token: SLACK_TOKEN,
    conversationId: CONVERSATION_ID,
    command,
    args,
    pattern: CODE_PATTERN,
    timeout: parseInt(TIMEOUT),
  };
};

const request2FACode = async (web: WebClient, conversationId: string) => {
  console.log(`Requesting 2FA token from channel ${conversationId}`);
  await web.channels.join({ name: conversationId });
  const res = await web.chat.postMessage({
    channel: conversationId,
    text: 'Please respond with 2FA code',
  });
  const { message, ts } = res;
  const { user } = message as { user: string };
  console.log('Requested 2FA token:', { user, ts });
  return { user, ts: ts as string };
};

const getHistory = async (
  web: WebClient,
  conversationId: string,
  ts: string,
) => {
  try {
    // public channels
    const res = await web.channels.history({
      channel: conversationId,
      oldest: ts,
      inclusive: false,
    });
    return res;
  } catch (e) {
    // private channels
    const res = await web.groups.history({
      channel: conversationId,
      oldest: ts,
      inclusive: false,
    });
    return res;
  }
};

const waitFor2FACode = async (
  web: WebClient,
  conversationId: string,
  timeout: number,
  ts: string,
  user: string,
) => {
  let timedout = false;
  const timeoutId = setTimeout(() => {
    timedout = true;
  }, timeout);

  while (!timedout) {
    const res = await getHistory(web, conversationId, ts);
    const messages = (res.messages as { text: string; type: string }[]).filter(
      ({ type }) => type === 'message',
    );
    for (const { text } of messages) {
      const match = text.match(new RegExp(`^<@${user}>(.+)$`));
      if (match && match[1]) {
        const code = match[1].trim();
        console.log(`Extracted 2FA code of length ${code.length}`);
        clearTimeout(timeoutId);
        return { error: null, code };
      }
    }
    console.log('Waiting for 2FA code');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return {
    error: new Error(`2FA message timed out after ${timeout} milliseconds`),
    code: '',
  };
};

const setupAuth = async () => {
  if (process.env.NPM_TOKEN) {
    const homeDir = os.homedir();
    const npmrcPath = path.join(homeDir, '.npmrc');
    await fs.writeFile(
      npmrcPath,
      `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}`,
    );
  }
};

(async () => {
  try {
    const {
      token,
      conversationId,
      command,
      args,
      pattern,
      timeout,
    } = getInputs();

    await setupAuth();
    const regex = new RegExp(pattern);
    const { error } = await new Promise(resolve => {
      const publishProcess = pty.spawn(command, args, {});
      const timeoutId = setTimeout(() => {
        publishProcess.kill();
        resolve({
          error: new Error(
            `publish command timed out after ${timeout} milliseconds`,
          ),
        });
      }, timeout);

      const handleError = (error: Error) => {
        publishProcess.kill();
        clearTimeout(timeoutId);
        resolve({ error });
      };

      let matched2fa = false;
      let muteOutput = false;
      let unmuteMessage = '';
      let currentMessage = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dataHandler = async (data: any) => {
        if (!muteOutput) {
          process.stdout.write(data);
        } else if (currentMessage === unmuteMessage) {
          muteOutput = false;
        } else {
          currentMessage = `${currentMessage}${data}`;
        }
        if (!matched2fa && regex.test(data.toString())) {
          try {
            console.log(`Matched 2FA code pattern ${regex.toString()}`);
            matched2fa = true;
            const web = new WebClient(token);
            const { user, ts } = await request2FACode(web, conversationId);
            const { error, code } = await waitFor2FACode(
              web,
              conversationId,
              timeout / 2,
              ts,
              user,
            );
            if (error) {
              handleError(error);
            } else {
              console.log(`Sending 2FA code to publish command`);
              muteOutput = true;
              unmuteMessage = code;
              publishProcess.write(`${code}\n`);
            }
          } catch (error) {
            handleError(error);
          }
        }
      };

      publishProcess.on('data', dataHandler);
      publishProcess.on('exit', code => {
        if (code !== 0) {
          handleError(
            new Error(
              `Publish command process exited with error code '${code}'`,
            ),
          );
        } else {
          clearTimeout(timeoutId);
          resolve({ error: null });
        }
      });
    });

    if (error) {
      core.setFailed(error.message);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
})();
