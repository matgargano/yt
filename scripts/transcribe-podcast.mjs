import { transcribeMissing } from '../transcribe.js';

const channelId = process.argv[2] || null;

await transcribeMissing({ channelId }, evt => {
  console.log(JSON.stringify(evt));
});
