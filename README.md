# 2fa-with-slack-action

## Usage

```yaml
on: [repository_dispatch]

jobs:
  publish:
    runs-on: ubuntu-latest
    name: Publish an NPM Package
    steps:
      - name: 2FA Publish step
        uses: erezrokah/2fa-with-slack-action@v1.0.0
        env:
          # npm token with publish permissions
          NPM_TOKEN: ${{secrets.NPM_TOKEN}}
          # slack token with bot scopes of `app_mentions:read,channels:history,channels:join,chat:write` and `groups.history` for private channel access
          SLACK_TOKEN: ${{secrets.SLACK_TOKEN}}
          # conversation id of slack channel to send the 2FA request message
          CONVERSATION_ID: ${{secrets.CONVERSATION_ID}}
          # line break separated list of command and args that perform the publish
          PUBLISH_COMMAND: "npm\npublish"
          # pattern to match on publish command output when token is needed
          CODE_PATTERN: 'Enter OTP'
```
