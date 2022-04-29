import axios from "axios";

export class NotificationUtil {
  public static async sendMessage(message) {
    if (process.env.SLACK_CHANNEL && process.env.SLACK_TOKEN) {
      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          text: `${message}`,
          channel: process.env.SLACK_CHANNEL,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.SLACK_TOKEN}`,
          },
        }
      );
    }
  }

  public static async sendBlockMessage(blocks) {
    if (process.env.SLACK_CHANNEL && process.env.SLACK_TOKEN) {
      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          blocks,
          channel: process.env.SLACK_CHANNEL,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.SLACK_TOKEN}`,
          },
        }
      );
    }
  }
}
