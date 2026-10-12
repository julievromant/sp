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

             case 'verify_magic_link': {
                // Si vous utilisez le code PKCE renvoyé par Supabase dans les query params (?code=...)
                const code = payload.code;
                
                let sessionUser = null;

                if (code) {
                    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
                    if (!sessionError && sessionData && sessionData.user) {
                        sessionUser = sessionData.user;
                    }
                }

                if (!sessionUser) {
                    throw new Error("Impossible de valider la session Supabase Auth.");
                }

                const userId = sessionUser.id;
                const email = sessionUser.email.toLowerCase();
                const metadata = sessionUser.user_metadata || {};

                // Vérifier si l'utilisateur existe déjà dans public.users
                let { data: existingUser } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();

                if (!existingUser) {
                    // S'il n'existe pas, on le crée avec les métadonnées du lien magique
                    const newUser = {
                        id: userId,
                        email: email,
                        firstname: metadata.firstname || 'Parent',
                        lastname: metadata.lastname || 'Bénévole',
                        phone: metadata.phone || null,
                        kids_classes: metadata.kids_classes || 'CP',
                        is_admin: email === 'marie.parent@apel.fr'
                    };

                    const { data: inserted, error: insertError } = await supabase.from('users').insert([newUser]).select().single();
                    if (insertError) throw new Error(insertError.message);
                    existingUser = inserted;
                }

                result = { status: 'success', user: existingUser };
                break;
            }
            
            case 'send_magic_link': {
                const email = (payload.email || '').trim().toLowerCase();
                const firstname = payload.firstname || 'Parent';
                const lastname = payload.lastname || 'Bénévole';
                const kidsClasses = payload.kidsClasses || 'CP';

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