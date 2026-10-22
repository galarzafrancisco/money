// Example demo scenario for scripts/record-demo.mjs: the signed-out landing page.
// It works without Taico because it stops before the redirect to sign in.
export default async function signInPage(page, { baseUrl, pause }) {
  await page.goto(`${baseUrl}/`);
  const signIn = page.getByRole('button', { name: /sign in with taico/i });
  await signIn.waitFor();
  await pause(1500);
  await signIn.hover();
  await pause(1200);
  await page.goto(`${baseUrl}/accounts`); // deep links also land on sign-in when signed out
  await signIn.waitFor();
  await pause(1500);
}
