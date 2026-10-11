import { createClient } from '@supabase/supabase-js';

// Utiliser onRequestPost indique explicitement à Cloudflare d'écouter les POST sur cette route
export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const body = await request.json();
        const { action, ...payload } = body;
        let result = { status: 'success' };

        const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

        switch (action) {
            case 'get_data': {
                const { data: events } = await supabase.from('events').select('*');
                const { data: users } = await supabase.from('users').select('*');
                result = { events: events || [], users: users || [] };
                break;
            }

            case 'save_event':
                await supabase.from('events').upsert(payload.event);
                break;

            case 'delete_event':
                await supabase.from('events').delete().eq('id', payload.eventId);
                break;

            case 'login': {
                const email = payload.email.trim().toLowerCase();
                let { data: user } = await supabase.from('users').select('*').eq('email', email).single();
                
                if (!user) {
                    const newUser = {
                        email: email,
                        firstname: payload.firstname || 'Parent',
                        lastname: payload.lastname || 'Bénévole',
                        kids_classes: payload.kidsClasses || 'CP',
                        is_admin: email === 'marie.parent@apel.fr'
                    };
                    await supabase.from('users').insert([newUser]);
                    user = newUser;
                }
                result = { status: 'success', user };
                break;
            }

            default:
                throw new Error('Action inconnue');
        }

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ status: 'error', message: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}