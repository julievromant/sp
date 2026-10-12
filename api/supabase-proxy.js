import { createClient } from '@supabase/supabase-js';

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const body = await request.json();
        const { action, ...payload } = body;
        let result = { status: 'success' };

        // Utilisation de la clé service_role pour les opérations admin/backend sécurisées
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

            case 'check_email': {
                const email = (payload.email || '').trim().toLowerCase();
                const { data, error } = await supabase.from('users').select('email').eq('email', email).maybeSingle();
                result = { exists: !!data };
                break;
            }

            case 'get_user_by_email': {
                const email = (payload.email || '').trim().toLowerCase();
                const { data: user } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
                result = { user: user || null };
                break;
            }

            case 'send_magic_link': {
                const email = (payload.email || '').trim().toLowerCase();
                const firstname = payload.firstname || 'Parent';
                const lastname = payload.lastname || 'Bénévole';
                const kidsClasses = payload.kidsClasses || 'CP';

                if (payload.isNew) {
                    const { data: listUsers } = await supabase.auth.admin.listUsers();
                    const existingAuthUser = listUsers?.users?.find(u => u.email.toLowerCase() === email);

                    if (existingAuthUser) {
                        await supabase.from('users').upsert({
                            id: existingAuthUser.id,
                            email: email,
                            firstname: firstname,
                            lastname: lastname,
                            kids_classes: kidsClasses,
                            is_admin: email === 'marie.parent@apel.fr'
                        });
                    }
                }

                // Envoi du lien magique via Supabase Auth
                const { data, error } = await supabase.auth.signInWithOtp({
                    email: email,
                    options: {
                        emailRedirectTo: new URL(request.url).origin + '/',
                        data: {
                            firstname: firstname,
                            lastname: lastname,
                            kids_classes: kidsClasses
                        }
                    }
                });

                if (error) {
                    throw new Error(error.message);
                }
                result = { status: 'success', message: 'Lien magique envoyé avec succès.' };
                break;
            }

            case 'verify_magic_link': {
                const code = payload.code;
                if (!code) throw new Error("Code d'authentification manquant.");

                const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
                if (sessionError || !sessionData || !sessionData.user) {
                    throw new Error(sessionError?.message || "Impossible de valider la session Supabase.");
                }

                const authUser = sessionData.user;
                const email = authUser.email.toLowerCase();
                const metadata = authUser.user_metadata || {};

                // Vérifier si l'utilisateur existe dans public.users
                let { data: dbUser } = await supabase.from('users').select('*').eq('id', authUser.id).maybeSingle();

                if (!dbUser) {
                    const newUser = {
                        id: authUser.id,
                        email: email,
                        firstname: metadata.firstname || 'Parent',
                        lastname: metadata.lastname || 'Bénévole',
                        kids_classes: metadata.kids_classes || 'CP',
                        is_admin: email === 'marie.parent@apel.fr'
                    };
                    const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
                    if (insertErr) throw new Error(insertErr.message);
                    dbUser = inserted;
                }

                result = { status: 'success', user: dbUser };
                break;
            }

            default:
                throw new Error('Action inconnue ou non gérée: ' + action);
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