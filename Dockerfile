FROM node:24-alpine
WORKDIR /usr/app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src src
COPY test test

CMD ["npm", "run", "mocha"]
