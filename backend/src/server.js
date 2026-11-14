const app = require('./app');
const { purgeExpiredSessions } = require('./auth/sessions');

const PORT = Number(process.env.PORT || 3000);

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref(); // hourly cleanup

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
