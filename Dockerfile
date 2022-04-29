FROM node:12.10.0-alpine

COPY . .

RUN ["yarn"]

RUN ["yarn", "build"]

EXPOSE 3000

ENTRYPOINT [ "yarn" ]

CMD ["start:prod"]

