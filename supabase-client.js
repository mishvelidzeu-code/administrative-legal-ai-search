const SUPABASE_URL = "https://bvwdvdiressqpnbsvhqf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_z4HRHdQaTSJ-FI9k6jljIw_XBxDqjOx";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabaseClient = supabaseClient;
