FROM node:24-alpine
WORKDIR /usr/app

COPY package.json ./
RUN npm install

COPY tsconfig.json tsconfig.test.json ./
COPY src src
COPY test test

ENTRYPOINT [ "npm" ]
CMD [ "run", "test:integration", "--silent" ]
