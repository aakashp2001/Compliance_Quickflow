/**
 * masters.config.js
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Define every master you want to test here.
 * The common script in all-masters.spec.js will iterate this list and run the
 * full Create → Verify → Update → Delete cycle for each entry.
 *
 * Fields
 * ──────
 * name         {string}  URL slug of the master page, e.g. "Department".
 *                        The test navigates to /<name>.
 *                        Use double-dashes for "&" (e.g. "Sales--Marketing")
 *                        and single dashes for spaces (e.g. "Employee-Type").
 *
 * user         {object}  Credentials for the logged-in user performing the test.
 *   .username  {string}
 *   .password  {string}
 *   .firstName {string}  Used to verify "who is logged in".
 *   .lastName  {string}
 *
 * updateTimes  {number}  How many times to update the record (default 1).
 * deleteTimes  {number}  How many times to delete the record (default 1).
 *
 * hasReview    {boolean} Set to true if the master requires a review step.
 * reviewUser   {object}  Reviewer credentials (same shape as `user`).
 *                        Required when hasReview = true.
 *
 * dynamicSchema {string} "Y" if the application uses dynamic site/app routing.
 * siteName     {string}  Site name to switch to when dynamicSchema = "Y".
 * appName      {string}  App  name to switch to when dynamicSchema = "Y".
 * ──────────────────────────────────────────────────────────────────────────────
 */

const DEFAULT_USER = {
  username: 'dhruvi',
  password: '',
  firstName: 'Dhruvi',
  lastName: 'Shah',
};

/** @type {import('./all-masters.spec').MasterConfig[]} */
const MASTERS = [
  // ── Manually add / edit masters here ───────────────────────────────────────────────
  // NOTE: For dynamic discovery of ALL masters (including new ones added to the app),
  // use auto-masters.spec.js instead. That script auto-discovers and tests every
  // master in the navigation menu.
  //
  // This static list is useful for testing a specific subset of masters or for
  // masters that require special configuration (hasReview, custom credentials, etc).

  {
    name: 'Department',
    user: DEFAULT_USER,
    updateTimes: 1,
    deleteTimes: 1,
    hasReview: false,
  },
  {
    name: 'Designation',
    user: DEFAULT_USER,
    updateTimes: 1,
    deleteTimes: 1,
    hasReview: false,
  },
  {
    name: 'Employee-Type',
    user: DEFAULT_USER,
    updateTimes: 1,
    deleteTimes: 1,
    hasReview: false,
  },
  {
    name: 'Location',
    user: DEFAULT_USER,
    updateTimes: 1,
    deleteTimes: 1,
    hasReview: false,
  },
  // ── Example: master that requires a review step ────────────────────────────
  // {
  //   name: 'Vendor',
  //   user: DEFAULT_USER,
  //   updateTimes: 1,
  //   deleteTimes: 1,
  //   hasReview: true,
  //   reviewUser: {
  //     username: 'reviewer_user',
  //     password: 'reviewer_pass',
  //     firstName: 'Reviewer',
  //     lastName: 'Name',
  //   },
  // },
];

module.exports = { MASTERS, DEFAULT_USER };
