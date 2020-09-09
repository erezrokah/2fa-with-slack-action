import { config } from 'dotenv';
import core = require('@actions/core');
import { WebClient } from '@slack/web-api';
import pty = require('node-pty');
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import execa from 'execa';

config();

const millisecondsToMinuets = (milliseconds: number) =>
  milliseconds / (60 * 1000);

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

const parseCommand = (commandString: string) => {
  const parts = commandString.split('\n');
  if (parts.length <= 0) {
    return { command: '', args: [] };
  }
  const command = parts[0];
  const args = parts.slice(1);
  return { command, args };
};

const getInputs = () => {
  const {
    SLACK_TOKEN = '',
    CHANNEL_ID = '',
    PUBLISH_COMMAND = '',
    CODE_PATTERN = '',
    TIMEOUT = `${20 * 60 * 1000}`,
    REVERT_COMMAND = '',
  } = process.env;

  const publishCommand = parseCommand(PUBLISH_COMMAND);
  console.log(
    `Received publish command of '${
      publishCommand.command
    }' with args '${publishCommand.args.join(',')}'`,
  );

  const revertCommand = parseCommand(REVERT_COMMAND);
  if (revertCommand.command) {
    console.log(
      `Received revert command of '${
        revertCommand.command
      }' with args '${revertCommand.args.join(',')}'`,
    );
  }
  return {
    token: SLACK_TOKEN,
    channelId: CHANNEL_ID,
    publishCommand,
    revertCommand,
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
  const text = `Received 2FA code ${code}`;
  try {
    console.log('Sending acknowledge message:', text);
    await web.chat.postMessage({
      channel,
      text,
    });
    console.log('Done sending acknowledge message:', text);
  } catch (e) {
    console.log('Failed sending acknowledge message', text);
  }
};

const reportExitMessage = async (
  web: WebClient,
  channel: string,
  message: string,
) => {
  try {
    console.log('Sending exit message:', message);
    await web.chat.postMessage({
      channel,
      text: message,
    });
    console.log('Done sending exit message:', message);
  } catch (e) {
    console.log('Failed sending exit message:', message);
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
    error: new Error(
      `2FA message timed out after ${millisecondsToMinuets(timeout)} minuets`,
    ),
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

const revertPublish = async (
  command: string,
  args: string[],
  timeout: number,
) => {
  let timeoutId;
  try {
    console.log(
      `Running revert command '${command}' with args '${args.join(',')}'`,
    );

    const subprocess = execa(command, args, { shell: true });
    subprocess.stdout?.pipe(process.stdout);
    subprocess.stderr?.pipe(process.stdout);

    timeoutId = setTimeout(() => {
      subprocess.cancel();
    }, timeout);

    await subprocess;
    console.log('Done running revert command');
  } catch (error) {
    if (error.isCanceled) {
      console.log(
        `Revert command timed out after '${millisecondsToMinuets(
          timeout,
        )}' minuets`,
      );
    } else {
      console.log('Failed running revert command', error);
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

(async () => {
  try {
    const {
      token,
      channelId,
      publishCommand,
      revertCommand,
      pattern,
      timeout,
    } = getInputs();

    await setupAuth();
    const regex = new RegExp(pattern);
    const { error, message } = await new Promise<{
      error: Error | null;
      message?: string;
    }>((resolve) => {
      const { command, args } = publishCommand;
      const publishProcess = pty.spawn(command, args, {
        env: process.env as Record<string, string>,
      });
      const timeoutId = setTimeout(() => {
        publishProcess.kill();
        resolve({
          error: new Error(
            `publish command timed out after ${millisecondsToMinuets(
              timeout,
            )} minuets`,
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
      const dataHandler = async (data: string | Buffer) => {
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
      if (revertCommand.command) {
        await revertPublish(
          revertCommand.command,
          revertCommand.args,
          timeout / 2,
        );
      }
      core.setFailed(error.message);
    } else {
      await reportExitMessage(
        new WebClient(token),
        channelId,
        message || 'Done running publish command',
      );
    }
  } catch (error) {
    core.setFailed(error.message);
  }
})();
