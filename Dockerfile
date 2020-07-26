FROM mhart/alpine-node:12

LABEL "com.github.actions.name"="2fa With Slack Action"
LABEL "com.github.actions.description"="A GitHub Action to publish a package with 2FA authentication using Slack"
LABEL "com.github.actions.icon"="hash"
LABEL "com.github.actions.color"="green"

LABEL "repository"="https://github.com/erezrokah/2fa-with-slack-action"
LABEL "homepage"="https://github.com/erezrokah/2fa-with-slack-action"
LABEL "maintainer"="Erez Rokah"
LABEL "version"="1.0.0"

RUN apk add --update bash
RUN apk add --update python
RUN apk add --update alpine-sdk
COPY package.json yarn.lock tsconfig.json /
COPY src/ src/
RUN yarn install --frozen-lockfile
RUN yarn build
ENTRYPOINT ["node", "/index.js"]
