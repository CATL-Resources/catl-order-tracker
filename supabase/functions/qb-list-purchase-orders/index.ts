import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get QB token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('qb_tokens')
      .select('access_token, realm_id')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (tokenErr || !tokenRow) {
      return new Response(JSON.stringify({ success: false, error: 'No QB token found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { access_token, realm_id } = tokenRow;

    // Query for open/recent POs - get all POs from the last 2 years
    const query = `SELECT * FROM PurchaseOrder WHERE TxnDate > '2024-01-01' ORDERBY TxnDate DESC MAXRESULTS 50`;
    const encodedQuery = encodeURIComponent(query);

    const qbRes = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${realm_id}/query?query=${encodedQuery}&minorversion=73`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/json',
        },
      }
    );

    if (!qbRes.ok) {
      const errText = await qbRes.text();
      return new Response(JSON.stringify({ success: false, error: `QB API ${qbRes.status}: ${errText}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const qbData = await qbRes.json();
    const pos = qbData?.QueryResponse?.PurchaseOrder || [];

    // Extract the useful info from each PO
    const summary = pos.map((po: any) => {
      const lines = (po.Line || []).filter((l: any) => l.DetailType === 'ItemBasedExpenseLineDetail');
      return {
        id: po.Id,
        doc_number: po.DocNumber,
        txn_date: po.TxnDate,
        vendor_name: po.VendorRef?.name,
        vendor_id: po.VendorRef?.value,
        total: po.TotalAmt,
        status: po.POStatus,
        memo: po.Memo || po.PrivateNote || null,
        line_count: lines.length,
        lines: lines.map((l: any) => ({
          item_name: l.ItemBasedExpenseLineDetail?.ItemRef?.name,
          item_id: l.ItemBasedExpenseLineDetail?.ItemRef?.value,
          qty: l.ItemBasedExpenseLineDetail?.Qty,
          unit_price: l.ItemBasedExpenseLineDetail?.UnitPrice,
          amount: l.Amount,
          description: l.Description || null,
        })),
      };
    });

    return new Response(JSON.stringify({
      success: true,
      total_pos: summary.length,
      purchase_orders: summary,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
