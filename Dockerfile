FROM apify/actor-node:18

COPY package.json ./
RUN npm install --omit=dev

COPY . ./

CMD ["node", "src/main.js"]
