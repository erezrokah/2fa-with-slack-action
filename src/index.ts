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
  'CHANNEL_ID',
  'PUBLISH_COMMAND',
  'CODE_PATTERN',
];
REQUIRED_ENV.forEach((key) => {
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
    CHANNEL_ID = '',
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
    channelId: CHANNEL_ID,
    command,
    args,
    pattern: CODE_PATTERN,
    timeout: parseInt(TIMEOUT),
  };
};

const request2FACode = async (web: WebClient, channel: string) => {
  console.log(`Requesting 2FA token from channel ${channel}`);
  await web.conversations.join({ channel }).catch((e) => {
    // the following error is expected for private channels
    if (e.data.error === 'method_not_supported_for_channel_type') {
      return;
    }
    throw e;
  });
  const res = await web.chat.postMessage({
    channel,
    text: 'Please respond with 2FA code',
  });
  const { message, ts } = res;
  const { user } = message as { user: string };
  console.log('Requested 2FA token:', { user, ts });
  return { user, ts: ts as string };
};

const acknowledge2FACode = async (
  web: WebClient,
  channel: string,
  code: string,
) => {
  try {
    console.log('Sending acknowledge message');
    await web.chat.postMessage({
      channel,
      text: `Received 2FA code ${code}`,
    });
    console.log('Done sending acknowledge message');
  } catch (e) {
    console.log('Failed sending acknowledge message');
  }
};

const reportExitMessage = async (
  web: WebClient,
  channel: string,
  message: string,
) => {
  try {
    console.log('Sending exit message');
    await web.chat.postMessage({
      channel,
      text: message,
    });
    console.log('Done sending exit message');
  } catch (e) {
    console.log('Failed sending exit message');
  }
};

const getHistory = async (web: WebClient, channel: string, ts: string) => {
  const res = await web.conversations.history({
    channel,
    oldest: ts,
    inclusive: false,
  });
  return res;
};

const waitFor2FACode = async (
  web: WebClient,
  channel: string,
  timeout: number,
  ts: string,
  user: string,
) => {
  let timedout = false;
  const timeoutId = setTimeout(() => {
    timedout = true;
  }, timeout);

  while (!timedout) {
    const res = await getHistory(web, channel, ts);
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
    const { token, channelId, command, args, pattern, timeout } = getInputs();

    await setupAuth();
    const regex = new RegExp(pattern);
    const { error, message } = await new Promise<{
      error: Error | null;
      message?: string;
    }>((resolve) => {
      const publishProcess = pty.spawn(command, args, {
        env: process.env as Record<string, string>,
      });
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
            const { user, ts } = await request2FACode(web, channelId);
            const { error, code } = await waitFor2FACode(
              web,
              channelId,
              timeout / 2,
              ts,
              user,
            );
            if (error) {
              handleError(error);
            } else {
              await acknowledge2FACode(web, channelId, code);
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
      publishProcess.on('exit', (code) => {
        const message = `Publish command process exited with exit code '${code}'`;
        if (code !== 0) {
          handleError(new Error(message));
        } else {
          clearTimeout(timeoutId);
          resolve({ error: null, message });
        }
      });
    });

    if (error) {
      await reportExitMessage(new WebClient(token), channelId, error.message);
      core.setFailed(error.message);
    }

    await reportExitMessage(
      new WebClient(token),
      channelId,
      error?.message || message || 'Done running publish command',
    );
  } catch (error) {
    core.setFailed(error.message);
  }
})();
